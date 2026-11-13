import { ClientInterface, ClientFetchManyOptions, ClientRequestOptions, BaseClient, BaseClientOptions, FaliedAttempt, HttpResponse,InvalidStatusCodeError, defaultUserAgent, delay } from "@xcrap/core"
import puppeteer, { Browser, Page, LaunchOptions } from "puppeteer"

import { defaultPuppeteerActionType } from "./constants"

export type PuppeteerProxy = string

export type PuppeteerClientOptions = BaseClientOptions<PuppeteerProxy> & LaunchOptions

export type PuppeteerClientActionFunction = (page: Page) => any | Promise<any>

export enum PuppeteerClientActionType {
    BeforeRequest = "beforeRequest",
    AfterRequest = "afterRequest"
}

export type PuppeteerClientAction = PuppeteerClientActionFunction | {
    type: `${PuppeteerClientActionType}`
    exec: PuppeteerClientActionFunction
}

export type ExtractActionsResult = {
    before: PuppeteerClientActionFunction[]
    after: PuppeteerClientActionFunction[]
}

export type PuppeterRequestOptions = Omit<
    ClientRequestOptions & {
        javaScriptEnabled?: boolean
        actions?: PuppeteerClientAction[]
    }, "method"
>

export type ConfigurePageOptions = {
    javaScriptEnabled: PuppeterRequestOptions["javaScriptEnabled"]
}

export type PageSession = {
    page: Page
    close: () => Promise<void>
}

export type ParsedProxy = {
    server: string
    credentials?: { username: string; password: string }
}

/** Splits `http://user:pass@host:port` into the server Chrome accepts and the credentials. */
export function parseProxy(proxy: string): ParsedProxy {
    let url: URL

    try {
        url = new URL(proxy)
    } catch {
        return { server: proxy }
    }

    if (!url.username) {
        return { server: proxy }
    }

    return {
        server: `${url.protocol}//${url.host}`,
        credentials: { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) },
    }
}

export type PuppeteerFetchManyOptions = ClientFetchManyOptions<PuppeterRequestOptions>

export class PuppeteerClient extends BaseClient<string> implements ClientInterface {
    protected browser?: Browser

    constructor(readonly options: PuppeteerClientOptions = {}) {
        super(options)

        this.options = options
        this.browser = undefined
    }

    protected async initBrowser(): Promise<void> {
        const puppeteerArguments: string[] = []

        if (this.options.args && this.options.args.length > 0) {
            puppeteerArguments.push(...this.options.args)
        }

        this.browser = await puppeteer.launch({
            ...this.options,
            args: puppeteerArguments,
            headless: this.options.headless ? "shell" : false
        })
    }

    protected async ensureBrowser(): Promise<void> {
        if (!this.browser) {
            await this.initBrowser()
        }
    }

    protected async closeBrowser(): Promise<void> {
        if (this.browser) {
            await this.browser.close()
            this.browser = undefined
        }
    }

    /**
     * Opens a page for one request. With a proxy, the page lives in its own browser context
     * using that proxy, so proxy functions are evaluated on every request.
     */
    protected async openPage(): Promise<PageSession> {
        const proxy = this.currentProxy

        if (!proxy) {
            const page = await this.browser!.newPage()
            return { page, close: () => page.close() }
        }

        const { server, credentials } = parseProxy(proxy)
        const context = await this.browser!.createBrowserContext({ proxyServer: server })
        const page = await context.newPage()

        if (credentials) {
            await page.authenticate(credentials)
        }

        return { page, close: () => context.close() }
    }

    protected async configurePage(page: Page, { javaScriptEnabled }: ConfigurePageOptions): Promise<void> {
        if (this.currentUserAgent) {
            await page.setUserAgent(this.currentUserAgent ?? defaultUserAgent)
        }

        if (javaScriptEnabled !== undefined) {
            await page.setJavaScriptEnabled(javaScriptEnabled)
        }
    }

    protected extractActions(actions: PuppeteerClientAction[] | undefined): ExtractActionsResult {
        const actionsBeforeRequest: PuppeteerClientActionFunction[] = []
        const actionsAfterRequest: PuppeteerClientActionFunction[] = []

        if (!actions) {
            actions = []
        }

        for (const action of actions) {
            const actionType = typeof action === "function" ? defaultPuppeteerActionType : action.type
            const actionFunc = typeof action === "function" ? action : action.exec

            if (actionType === "beforeRequest") {
                actionsBeforeRequest.push(actionFunc)
            } else {
                actionsAfterRequest.push(actionFunc)
            }
        }

        return {
            before: actionsBeforeRequest,
            after: actionsAfterRequest
        }
    }

    protected async executeActions(page: Page, actions: PuppeteerClientActionFunction[]): Promise<void> {
        for (const action of actions) {
            await action(page)
        }
    }

    async fetch({
        url,
        javaScriptEnabled,
        maxRetries = 0,
        actions,
        retries = 0,
        retryDelay,
    }: PuppeterRequestOptions): Promise<HttpResponse> {
        await this.ensureBrowser()

        const failedAttempts: FaliedAttempt[] = []

        const attemptRequest = async (currentRetry: number): Promise<HttpResponse> => {
            let session: PageSession | undefined
            let result: HttpResponse | undefined
            let errorMessage: string

            try {
                const fullUrl = this.currentProxyUrl ? `${this.currentProxyUrl}${url}` : url

                const {
                    before: actionsBeforeRequest,
                    after: actionsAfterRequest
                } = this.extractActions(actions)

                session = await this.openPage()
                const { page } = session

                await this.configurePage(page, { javaScriptEnabled: javaScriptEnabled })
                await this.executeActions(page, actionsBeforeRequest)
                const response = await page.goto(fullUrl)
                await this.executeActions(page, actionsAfterRequest)
                const content = await page.content()

                const status = response?.status() ?? 200

                result = new HttpResponse({
                    body: content,
                    headers: response?.headers() || {},
                    status: status,
                    statusText: response?.statusText() || "",
                    attempts: currentRetry + 1,
                    failedAttempts: failedAttempts,
                })

                if (this.isSuccess(status)) {
                    return result
                }

                errorMessage = new InvalidStatusCodeError(status, fullUrl).message
            } catch (error: any) {
                errorMessage = error instanceof Error ? error.message : "Unknown error"
            } finally {
                await session?.close().catch(() => {})
            }

            failedAttempts.push({ error: errorMessage, timestamp: new Date() })

            if (currentRetry < maxRetries) {
                if (retryDelay !== undefined && retryDelay > 0) {
                    await delay(retryDelay)
                }

                return await attemptRequest(currentRetry + 1)
            }

            if (result) {
                return result
            }

            return new HttpResponse({
                body: errorMessage,
                headers: {},
                status: 500,
                statusText: "Request Failed",
                attempts: currentRetry + 1,
                failedAttempts: failedAttempts,
            })
        }

        return await attemptRequest(retries)
    }

    async fetchMany({ requests, concurrency, requestDelay }: PuppeteerFetchManyOptions): Promise<HttpResponse[]> {
        const results: HttpResponse[] = []
        const executing: Promise<void>[] = []

        for (let i = 0; i < requests.length; i++) {
            const promise = this.executeRequest({
                request: requests[i],
                index: i,
                requestDelay: requestDelay,
                results: results
            }).then(() => undefined)

            executing.push(promise)

            if (this.shouldThrottle(executing, concurrency)) {
                await this.handleConcurrency(executing)
            }
        }

        await Promise.all(executing)

        return results
    }

    async close(): Promise<void> {
        if (this.browser) {
            await this.closeBrowser()
        }
    }
}