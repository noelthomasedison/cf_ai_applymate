import { routeAgentRequest, type Schedule } from "agents";
export { GeneratePackWorkflow } from "./workflow";
import { getSchedulePrompt } from "agents/schedule";

import { AIChatAgent } from "@cloudflare/ai-chat";
import {
  generateId,
  streamText,
  type StreamTextOnFinishCallback,
  stepCountIs,
  createUIMessageStream,
  convertToModelMessages,
  createUIMessageStreamResponse,
  type ToolSet
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { processToolCalls, cleanupMessages } from "./utils";
import { tools, executions } from "./tools";
type ChatState = {
  profile?: string;
  job?: string;
  lastPackId?: string;
};
// import { env } from "cloudflare:workers";

/**
 * Chat Agent implementation that handles real-time AI chat interactions
 */

export class Chat extends AIChatAgent<Env, ChatState> {
  initialState: ChatState = { profile: "", job: "", lastPackId: "" };

  setMemory(patch: Partial<ChatState>) {
    this.setState({ ...this.state, ...patch });
  }

  getMemory() {
    return this.state;
  }

  async startPack(appId?: string) {
    const profile = this.state.profile?.trim();
    const job = this.state.job?.trim();

    if (!profile) return "❌ No profile saved. Use /profile <text> first.";
    if (!job) return "❌ No job description saved. Use /job <text> first.";

    const id = crypto.randomUUID();
    const instance = await this.env.GENERATE_PACK.create({
      id,
      params: {
        appId: appId ?? id,
        resume: profile,
        jd: job
      }
    });

    this.setMemory({ lastPackId: instance.id });

    return `🚀 Started workflow generate-pack.\nInstance ID: ${instance.id}\nUse /pack_status to check progress.`;
  }

  async packStatus(instanceId?: string) {
    const id = instanceId ?? this.state.lastPackId;
    if (!id) return "❌ No workflow instance id found. Run /pack first.";

    const instance = await this.env.GENERATE_PACK.get(id);
    const status = await instance.status();
    return { id, status };
  }
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: { abortSignal?: AbortSignal }
  ) {
    // const mcpConnection = await this.mcp.connect(
    //   "https://path-to-mcp-server/sse"
    // );

    // Collect all tools, including MCP tools
    let mcpTools = {};
    try {
      mcpTools = this.mcp.getAITools();
    } catch (e) {
      console.log("MCP tools unavailable:", e);
    }

    const allTools = {
      ...tools,
      ...mcpTools
    };
    const workersai = createWorkersAI({ binding: this.env.AI });
    const model = workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast" as any);

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        // Clean up incomplete tool calls to prevent API errors
        const cleanedMessages = cleanupMessages(this.messages);

        // Process any pending tool calls from previous messages
        // This handles human-in-the-loop confirmations for tools
        const processedMessages = await processToolCalls({
          messages: cleanedMessages,
          dataStream: writer,
          tools: allTools,
          executions
        });

        const result = streamText({
          system: `You are ApplyMate, an AI assistant that helps generate application packs.

Slash commands:
- "/profile ..." -> call setProfile with the remaining text.
- "/job ..." -> call setJob with the remaining text.
- "/memory" -> call getMemory.
- "/clear" -> call clearMemory.
- "/pack" -> call createPack.
- "/pack_status" -> call packStatus.

${getSchedulePrompt({ date: new Date() })}

If the user asks to schedule a task, use the schedule tool to schedule the task.
`,
          messages: await convertToModelMessages(processedMessages),
          model,
          tools: allTools,
          // Type boundary: streamText expects specific tool types, but base class uses ToolSet
          // This is safe because our tools satisfy ToolSet interface (verified by 'satisfies' in tools.ts)
          onFinish: onFinish as unknown as StreamTextOnFinishCallback<
            typeof allTools
          >,
          stopWhen: stepCountIs(10),
          abortSignal: options?.abortSignal
        });

        writer.merge(result.toUIMessageStream());
      }
    });

    return createUIMessageStreamResponse({ stream });
  }
  async executeTask(description: string, _task: Schedule<string>) {
    await this.saveMessages([
      ...this.messages,
      {
        id: generateId(),
        role: "user",
        parts: [
          {
            type: "text",
            text: `Running scheduled task: ${description}`
          }
        ],
        metadata: {
          createdAt: new Date()
        }
      }
    ]);
  }
}

/**
 * Worker entry point that routes incoming requests to the appropriate handler
 */
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      // Route the request to our agent or return 404 if not found
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
