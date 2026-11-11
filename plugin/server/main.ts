// The Deck service: an MCP server over stdio that exposes the task kernel as
// `deck_*` tools. The host starts it on demand; its Workspace comes from the
// working directory it was started in (ADR-0005), never from a path passed by
// a caller.
// Runs on plain Node with no installed packages, so MCP is spoken by hand.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

import { readProjectConfig } from '../kernel/config.ts'

// The Workspace is the checkout the service was started in: the nearest
// directory at or above the working directory that holds `.git`. Outside a
// repository it is the working directory itself.
let workspace = process.cwd()
for (let dir = workspace; ; dir = dirname(dir)) {
  if (existsSync(join(dir, '.git'))) {
    workspace = dir
    break
  }
  if (dir === dirname(dir)) {
    break
  }
}

type ToolResult = {
  content: { type: 'text'; text: string }[]
  structuredContent?: object
  isError: boolean
}

const tools = {
  deck_config: {
    description:
      'Read the Matt Deck project config (.matt-deck/config.json) of the workspace this service was started in.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (): Promise<ToolResult> => {
      const result = await readProjectConfig(workspace)

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
        isError: false,
      }
    },
  },
}

const handle = async (method: string, params: any): Promise<object> => {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'matt-deck', version: '0.1.0' },
      }
    case 'ping':
      return {}
    case 'tools/list':
      return {
        tools: Object.entries(tools).map(([name, { description, inputSchema }]) => ({
          name,
          description,
          inputSchema,
        })),
      }
    case 'tools/call': {
      const tool = tools[params?.name as keyof typeof tools]
      if (tool === undefined) {
        throw Object.assign(new Error(`Unknown tool: ${params?.name}`), { code: -32602 })
      }
      // No tool takes arguments yet; in particular none takes a workspace path.
      if (Object.keys(params?.arguments ?? {}).length > 0) {
        return {
          content: [{ type: 'text', text: `${params.name} takes no arguments` }],
          isError: true,
        }
      }

      // A failing tool answers as a tool error the caller can show, not a
      // protocol error.
      return tool.run().catch(
        (error: Error): ToolResult => ({
          content: [{ type: 'text', text: error.message }],
          isError: true,
        }),
      )
    }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
  }
}

const send = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

createInterface({ input: process.stdin }).on('line', async line => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    send({ id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }
  // Notifications (no id) need no answer.
  if (message.id === undefined) {
    return
  }
  try {
    send({ id: message.id, result: await handle(message.method, message.params) })
  } catch (error: any) {
    send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } })
  }
})
