import { v1 as UUIDv1 } from 'uuid'
import sessions, { SessionsCacheItem } from './session'
import { RequestContext } from './types'
import log from './log'
import { Browser, SetCookie, Request, Page, Headers, HttpMethod, Overrides, Response } from 'puppeteer'
import getCaptchaSolver, { CaptchaType } from './captcha'
import { Context } from 'vm'
import * as tmp from 'tmp';
import * as fs from 'fs';
import * as path from 'path';

export interface BaseAPICall {
  cmd: string
}

interface BaseSessionsAPICall extends BaseAPICall {
  session?: string
}

interface SessionsCreateAPICall extends BaseSessionsAPICall {
  userAgent?: string,
  cookies?: SetCookie[],
  headers?: Headers
  maxTimeout?: number
  proxy?: any
}

interface BaseRequestAPICall extends BaseAPICall {
  url: string
  method?: HttpMethod
  postData?: string
  session?: string
  userAgent?: string
  maxTimeout?: number
  cookies?: SetCookie[],
  headers?: Headers
  proxy?: any, // TODO: use interface not any
  download?: boolean
}


interface Routes {
  [key: string]: (ctx: RequestContext, params: BaseAPICall) => void | Promise<void>
}

interface ChallengeResolutionResultT {
  url: string
  status: number,
  headers?: Headers,
  response: string,
  cookies: object[]
  userAgent: string
}

interface ChallengeResolutionT {
  status?: string
  message: string
  result: ChallengeResolutionResultT
}

interface OverrideResolvers {
  method?: (request: Request) => HttpMethod,
  postData?: (request: Request) => string,
  headers?: (request: Request) => Headers
}


const CHALLENGE_SELECTORS = ['.ray_id', '.attack-box']
const TOKEN_INPUT_NAMES = ['g-recaptcha-response', 'h-captcha-response']

async function resolveChallenge(ctx: RequestContext, { url, maxTimeout, proxy, download }: BaseRequestAPICall, page: Page, downloadPath: string): Promise<ChallengeResolutionT | void> {

  maxTimeout = maxTimeout || 60000
  let downloadsFound = false
  let status = 'ok'
  let message = ''

  if (proxy) {
    log.debug("Apply proxy")
    if (proxy.username)
      await page.authenticate({ username: proxy.username, password: proxy.password })
  }

  let response: Response | void
  let loadFailed = false
  log.debug(`Navigating to... ${url}`)
  await page.goto(url, { waitUntil: 'load' }).catch(() => {loadFailed = true}).then(r => response = r)

  if (download && loadFailed) {
    // It may have started a download while the page failed to load
    await page.waitFor(1000)
  }

  if (download && fs.readdirSync(downloadPath).length > 0) {
    console.debug('Found a download running, stopping challenge resolution')
    downloadsFound = true
  }

  // look for challenge
  if (!downloadsFound && response && response.headers().server.startsWith('cloudflare')) {
    log.info('Cloudflare detected')

    if (await page.$('.cf-error-code')) {
      await page.close()
      return ctx.errorResponse('Cloudflare has blocked this request (Code 1020 Detected).')
    }

    if (response.status() > 400) {
      // detect cloudflare wait 5s
      for (const selector of CHALLENGE_SELECTORS) {
        const cfChallengeElem = await page.$(selector)
        if (cfChallengeElem) {
          log.html(await page.content())
          log.debug('Waiting for Cloudflare challenge...')

          // TODO: find out why these pages hang sometimes
          while (Date.now() - ctx.startTimestamp < maxTimeout) {
            await page.waitFor(1000)
            try {
              // catch exception timeout in waitForNavigation
              await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 })
            } catch (error) { }

            // Do not refresh if a download is currently running
            if (fs.readdirSync(downloadPath).length > 0) {
              console.debug('Found a download running, stopping challenge resolution')
              downloadsFound = true
              break
            } else {
              const cfChallengeElem = await page.$(selector)
              if (!cfChallengeElem) { break }
              log.debug('Found challenge element again...')

              response = await page.reload({ waitUntil: 'domcontentloaded' })
              log.debug('Reloaded page...')
            }
          }

          if (Date.now() - ctx.startTimestamp >= maxTimeout) {
            ctx.errorResponse(`Maximum timeout reached. maxTimeout=${maxTimeout} (ms)`)
            return
          }

          log.debug('Validating HTML code...')
          break
        } else {
          log.debug(`No '${selector}' challenge element detected.`)
        }
      }
    }

    // it seems some captcha pages return 200 sometimes
    if (await page.$('input[name="cf_captcha_kind"]')) {
      const captchaSolver = getCaptchaSolver()
      if (captchaSolver) {
        const captchaStartTimestamp = Date.now()
        const challengeForm = await page.$('#challenge-form')
        if (challengeForm) {
          log.html(await page.content())
          const captchaTypeElm = await page.$('input[name="cf_captcha_kind"]')
          const cfCaptchaType: string = await captchaTypeElm.evaluate((e: any) => e.value)
          const captchaType: CaptchaType = (CaptchaType as any)[cfCaptchaType]
          if (!captchaType) { return ctx.errorResponse('Unknown captcha type!') }

          const sitekeyElem = await page.$('*[data-sitekey]')
          if (!sitekeyElem) { return ctx.errorResponse('Could not find sitekey!') }
          const sitekey = await sitekeyElem.evaluate((e) => e.getAttribute('data-sitekey'))

          log.info('Waiting to recive captcha token to bypass challenge...')
          const token = await captchaSolver({
            hostname: (new URL(url)).hostname,
            sitekey,
            type: captchaType
          })

          for (const name of TOKEN_INPUT_NAMES) {
            const input = await page.$(`textarea[name="${name}"]`)
            if (input) { await input.evaluate((e: HTMLTextAreaElement, token) => { e.value = token }, token) }
          }

          // ignore preset event listeners on the form
          await page.evaluate(() => {
            window.addEventListener('submit', (e) => { event.stopPropagation() }, true)
          })

          // this element is added with js and we want to wait for all the js to load before submitting
          await page.waitForSelector('#challenge-form [type=submit]')

          // calculates the time it took to solve the captcha
          const captchaSolveTotalTime = Date.now() - captchaStartTimestamp

          // generates a random wait time
          const randomWaitTime = (Math.floor(Math.random() * 20) + 10) * 1000

          // waits, if any, time remaining to apper human but stay as fast as possible
          const timeLeft = randomWaitTime - captchaSolveTotalTime
          if (timeLeft > 0) { await page.waitFor(timeLeft) }

          // submit captcha response
          challengeForm.evaluate((e: HTMLFormElement) => e.submit())
          response = await page.waitForNavigation({ waitUntil: 'domcontentloaded' })
        }
      } else {
        status = 'warning'
        message = 'Captcha detected but no automatic solver is configured.'
      }
    }
  }

  const payload: ChallengeResolutionT = {
    status,
    message,
    result: {
      url: page.url(),
      status: response ? response.status(): 500,
      headers: response ? response.headers() : {},
      response: null,
      cookies: await page.cookies(),
      userAgent: await page.evaluate(() => navigator.userAgent)
    }
  }

  payload.result.response = await page.content()

  // If we were waiting for a download then consider it's a 200
  if (downloadsFound) {
    // Check that the download is done
    while (fs.readdirSync(downloadPath).filter(name => !name.endsWith('.crdownload')).length < 1) {
      await new Promise(r => setTimeout(r, 100));
    }
    const fileName = fs.readdirSync(downloadPath)[0]
    const filePath = path.join(downloadPath, fileName)

    payload.result.status = 200
    payload.result.response = fs.readFileSync(filePath).toString('base64')
  }

  // make sure the page is closed becaue if it isn't and error will be thrown
  // when a user uses a temporary session, the browser make be quit before
  // the page is properly closed.
  await page.close()

  return payload
}

function mergeSessionWithParams({ defaults }: SessionsCacheItem, params: BaseRequestAPICall): BaseRequestAPICall {
  const copy = { ...defaults, ...params }

  // custom merging logic
  copy.headers = { ...defaults.headers || {}, ...params.headers || {} } || null

  return copy
}

async function setupPage(ctx: Context, params: BaseRequestAPICall, browser: Browser, downloadPath: string): Promise<Page> {
  const page = await browser.newPage()

  // merge session defaults with params
  const { method, postData, download, userAgent, headers, cookies } = params

  let overrideResolvers: OverrideResolvers = {}

  if (method !== 'GET') {
    log.debug(`Setting method to ${method}`)
    overrideResolvers.method = (request: Request) => method
  }

  if (postData) {
    log.debug(`Setting body data to ${postData}`)
    overrideResolvers.postData = (request: Request) => postData
  }

  if (userAgent) {
    log.debug(`Using custom UA: ${userAgent}`)
    await page.setUserAgent(userAgent)
  }

  if (download) {
    // @ts-ignore
    await page._client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath })
  }

  if (headers) {
    log.debug(`Adding custom headers: ${JSON.stringify(headers, null, 2)}`,)
    overrideResolvers.headers = (request: Request) => Object.assign(request.headers(), headers)
  }

  if (cookies) {
    log.debug(`Setting custom cookies: ${JSON.stringify(cookies, null, 2)}`,)
    await page.setCookie(...cookies)
  }

  log.debug(overrideResolvers)

  const callback = (request: Request) => {
    let once = false

    if (once || !request.isNavigationRequest()) {
      request.continue()
      return
    }

    once = true

    const overrides: Overrides = {}

    // This can probably be enhanced by looping through overrideResolvers
    // but my knowledge of TypeScript is too limited

    if (overrideResolvers.method) {
      overrides.method = overrideResolvers.method(request)
    }

    if (overrideResolvers.postData) {
      overrides.postData = overrideResolvers.postData(request)
    }

    if (overrideResolvers.headers) {
      overrides.headers = overrideResolvers.headers(request)
    }

    log.debug(overrides)

    request.continue(overrides)
  }

  await page.setRequestInterception(true)
  page.on('request', callback)

  return page
}

export const routes: Routes = {
  'sessions.create': async (ctx, { session, ...options }: SessionsCreateAPICall) => {
    session = session || UUIDv1()
    const { browser } = await sessions.create(session, options)
    if (browser) { ctx.successResponse('Session created successfully.', { session }) }
  },
  'sessions.list': (ctx) => {
    ctx.successResponse(null, { sessions: sessions.list() })
  },
  'sessions.destroy': async (ctx, { session }: BaseSessionsAPICall) => {
    if (await sessions.destroy(session)) { return ctx.successResponse('The session has been removed.') }
    ctx.errorResponse('This session does not exist.')
  },
  'request.get': async (ctx, params: BaseRequestAPICall) => {
    const oneTimeSession = params.session === undefined
    const sessionId = params.session || UUIDv1()
    const session = oneTimeSession
      ? await sessions.create(sessionId, {
        userAgent: params.userAgent,
        oneTimeSession
      })
      : sessions.get(sessionId)

    if (session === false) {
      return ctx.errorResponse('This session does not exist. Use \'list_sessions\' to see all the existing sessions.')
    }

    params = mergeSessionWithParams(session, params)

    let downloadPath = null
    let downloadPathName: string = null

    if (params.download) {
      downloadPath = tmp.dirSync()
      downloadPathName = downloadPath.name
      console.debug('Temporary download folder: ', downloadPath.name)
    }

    const page = await setupPage(ctx, params, session.browser, downloadPathName)
    const data = await resolveChallenge(ctx, params, page, downloadPathName)

    if (params.download) {
      fs.readdirSync(downloadPathName).forEach(file => {
        const filePath = path.join(downloadPathName, file);
        console.debug(filePath)
        fs.unlinkSync(filePath)
      })
      downloadPath.removeCallback()
    }

    if (data) {
      const { status } = data
      delete data.status
      console.log(status)
      ctx.successResponse(data.message, {
        ...(oneTimeSession ? {} : { session: sessionId }),
        ...(status ? { status } : {}),
        solution: data.result
      })
    }

    if (oneTimeSession) { sessions.destroy(sessionId) }
  }
}

export default async function Router(ctx: RequestContext, params: BaseAPICall): Promise<void> {
  const route = routes[params.cmd]
  if (route) { return await route(ctx, params) }
  return ctx.errorResponse(`The command '${params.cmd}' is invalid.`)
}