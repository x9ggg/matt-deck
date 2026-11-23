// The Host's end of the Pane in a Codex tab, played by the tests. It loads
// the page the Deck service serves into jsdom, as Codex loads it into a frame,
// answers the page's handshake and the tool calls it sends through the Host,
// and records every message the page sends and every resource it asks for.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { JSDOM, requestInterceptor } from 'jsdom'

export const PANE_PAGE = join(import.meta.dirname, '..', 'plugin', 'codex', 'pane.html')

// A tool's answer as the Deck service gives it.
export const answered = (structuredContent: object) => ({
  content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
  structuredContent,
  isError: false,
})

// The Host's context as it gives it to the page; `theme` is its appearance.
type HostContext = { theme?: 'light' | 'dark'; [key: string]: unknown }

export const openPage = async ({
  answer,
  hostContext = {},
}: {
  // What the Deck service answers a tool call the Host passes on; the page's
  // document is there to read what the page shows while the call is open.
  answer: (name: string, args: object, document: Document) => object | Promise<object>
  hostContext?: HostContext
}) => {
  const html = await readFile(PANE_PAGE, 'utf8')
  const host = new JSDOM('').window
  const sent: any[] = []
  const fetched: string[] = []
  let unanswered = 0

  // The page's clock: Date.now() and the page's timers run on a time the
  // test moves with advance(), from the moment the page opens.
  let now = Date.UTC(2026, 10, 22, 9, 0)
  let lastTimer = 0
  const timers = new Map<number, { at: number; every?: number; run: () => void }>()
  const timer = (every: boolean) => (run: () => void, ms = 0) => {
    timers.set(++lastTimer, { at: now + ms, ...(every ? { every: Math.max(1, ms) } : {}), run })
    return lastTimer
  }

  const page = new JSDOM(html, {
    runScripts: 'dangerously',
    // Every request goes through here and reaches no network.
    resources: {
      interceptors: [
        requestInterceptor(request => {
          fetched.push(request.url)
          return new Response('', { status: 404 })
        }),
      ],
    },
    pretendToBeVisual: true,
    beforeParse: window => {
      // The page talks to the frame's parent, which is the Host.
      Object.defineProperty(window, 'parent', { value: host })
      Object.assign(window, {
        setTimeout: timer(false),
        setInterval: timer(true),
        clearTimeout: (id: number) => timers.delete(id),
        clearInterval: (id: number) => timers.delete(id),
      })
      window.Date.now = () => now
    },
  })
  const toPage = (message: object) =>
    page.window.dispatchEvent(
      new page.window.MessageEvent('message', { data: { jsonrpc: '2.0', ...message }, source: host as any }),
    )
  // The Host writes its appearance on the page's root element, as Codex does,
  // over whatever the page wrote there.
  const showTheme = ({ theme }: HostContext) => {
    if (theme !== undefined) {
      page.window.document.documentElement.dataset.theme = theme
    }
  }

  host.addEventListener('message', async (event: any) => {
    // A copy, as a frame's message reaches its parent cloned.
    const data = JSON.parse(JSON.stringify(event.data))
    sent.push(data)
    if (data.method === 'ui/notifications/initialized') {
      // Once the handshake is done, so after the page has followed the theme.
      showTheme(hostContext)
    }
    if (data.id === undefined) {
      return
    }
    unanswered++
    if (data.method === 'ui/initialize') {
      toPage({
        id: data.id,
        result: { protocolVersion: '2026-01-26', hostInfo: { name: 'fake-host' }, hostCapabilities: {}, hostContext },
      })
    } else if (data.method === 'tools/call') {
      toPage({ id: data.id, result: await answer(data.params.name, data.params.arguments, page.window.document) })
    } else if (data.method === 'ui/message') {
      // A message the page puts in the Session's prompt, or sends; the test
      // reads it from `sent`.
      toPage({ id: data.id, result: {} })
    } else {
      toPage({ id: data.id, error: { code: -32601, message: `Method not found: ${data.method}` } })
    }
    unanswered--
  })

  // Resolves once the page has had every answer and sent nothing new for a
  // few ticks.
  const settled = async () => {
    let quiet = 0
    let seen = sent.length
    while (quiet < 3) {
      await new Promise(resolve => setTimeout(resolve, 5))
      quiet = unanswered === 0 && sent.length === seen ? quiet + 1 : 0
      seen = sent.length
    }
  }
  await settled()

  return {
    document: page.window.document,
    window: page.window,
    sent,
    fetched,
    html,
    settled,
    // A notification from the Host, such as a change of its context. A change
    // of its appearance it writes on the root element before it tells the page.
    notify: async (method: string, params: HostContext) => {
      if (method === 'ui/notifications/host-context-changed') {
        showTheme(params)
      }
      toPage({ method, params })
      await settled()
    },
    // Moves the page's clock on, running each timer as it comes due.
    advance: async (ms: number) => {
      const until = now + ms
      for (;;) {
        const due = [...timers].filter(([, each]) => each.at <= until).sort(([, a], [, b]) => a.at - b.at)[0]
        if (due === undefined) {
          break
        }
        const [id, each] = due
        now = each.at
        if (each.every === undefined) {
          timers.delete(id)
        } else {
          each.at += each.every
        }
        each.run()
      }
      now = until
      await settled()
    },
    click: async (element: Element | null) => {
      ;(element as HTMLElement).click()
      await settled()
    },
    // The Host shows the tab or hides it, as the person switches to it or
    // away, and the page hears of it as a browser tells a page.
    show: async (visible: boolean) => {
      const { document, Event } = page.window
      Object.defineProperty(document, 'visibilityState', { value: visible ? 'visible' : 'hidden', configurable: true })
      Object.defineProperty(document, 'hidden', { value: !visible, configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      await settled()
    },
    close: () => {
      page.window.close()
      host.close()
    },
  }
}
