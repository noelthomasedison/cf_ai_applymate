// src/workflow.ts
import {
  WorkflowEntrypoint,
  type WorkflowStep,
  type WorkflowEvent
} from "cloudflare:workers";
import { createWorkersAI } from "workers-ai-provider";
import { generateObject } from "ai";
import { z } from "zod";

type Env = {
  AI: Ai;
};

type Params = {
  appId: string;
  resume: string;
  jd: string;
};

export class GeneratePackWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const model = workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast" as any);

    const requirements = await step.do("extract_requirements", async () => {
      const res = await generateObject({
        model,
        schema: z.object({
          role_title: z.string().optional(),
          must_haves: z.array(z.string()),
          nice_to_haves: z.array(z.string())
        }),
        prompt: `Extract key requirements from this job description:\n\n${event.payload.jd}`
      });
      // Return only plain JSON (serializable)
      return res.object;
    });

    const bullets = await step.do("tailor_resume_bullets", async () => {
      const res = await generateObject({
        model,
        schema: z.object({
          bullets: z.array(z.string()).min(5).max(10)
        }),
        prompt:
          `Resume:\n${event.payload.resume}\n\n` +
          `Requirements:\n${JSON.stringify(requirements)}\n\n` +
          `Write 5–10 achievement bullets tailored to the JD.`
      });
      return res.object;
    });

    const coverLetter = await step.do("draft_cover_letter", async () => {
      const res = await generateObject({
        model,
        schema: z.object({ letter: z.string() }),
        prompt:
          `Write a 250–350 word cover letter using:\n\n` +
          `Resume:\n${event.payload.resume}\n\n` +
          `Job Description:\n${event.payload.jd}`
      });
      return res.object;
    });

    const interview = await step.do("interview_questions", async () => {
      const res = await generateObject({
        model,
        schema: z.object({
          questions: z.array(z.string()).min(8).max(12)
        }),
        prompt: `Generate 8–12 interview questions (technical + behavioral) for:\n\n${event.payload.jd}`
      });
      return res.object;
    });

    return {
      requirements,
      bullets: bullets.bullets,
      cover_letter: coverLetter.letter,
      interview: interview.questions
    };
  }
}
