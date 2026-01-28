// src/workflow.ts
import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
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
    const model = workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast");

    const { resume, jd } = event.payload;

    const requirements = await step.do("extract_requirements", async () => {
      return generateObject({
        model,
        schema: z.object({
          role_title: z.string().optional(),
          must_haves: z.array(z.string()),
          nice_to_haves: z.array(z.string()),
        }),
        prompt: `Extract key requirements from this job description:\n\n${jd}`,
      });
    });

    const bullets = await step.do("tailor_resume_bullets", async () => {
      return generateObject({
        model,
        schema: z.object({
          bullets: z.array(z.string()).min(5).max(10),
        }),
        prompt:
          `Resume:\n${resume}\n\n` +
          `Requirements:\n${JSON.stringify(requirements.object)}\n\n` +
          `Write 5–10 achievement bullets tailored to the JD.`,
      });
    });

    const coverLetter = await step.do("draft_cover_letter", async () => {
      return generateObject({
        model,
        schema: z.object({ letter: z.string() }),
        prompt:
          `Write a 250–350 word cover letter using:\n\n` +
          `Resume:\n${resume}\n\nJob Description:\n${jd}\n\n` +
          `Focus on quantified impact and match the must-haves.`,
      });
    });

    const interview = await step.do("interview_questions", async () => {
      return generateObject({
        model,
        schema: z.object({
          questions: z.array(z.string()).min(8).max(12),
        }),
        prompt: `Generate 8–12 interview questions (technical + behavioral) for:\n\n${jd}`,
      });
    });

    return {
      requirements: requirements.object,
      bullets: bullets.object,
      cover_letter: coverLetter.object,
      interview: interview.object,
    };
  }
}

