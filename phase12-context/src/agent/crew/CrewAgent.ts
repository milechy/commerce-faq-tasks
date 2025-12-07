// src/agent/crew/CrewAgent.ts

import type { DialogAgentMeta } from "../dialog/types";

export type CrewAgentInput = {
  message: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  context?: any;
};

export type CrewAgentOutput = {
  text: string;
  reasoning?: string;
  meta?: DialogAgentMeta;
};

export class CrewAgent {
  name: string;
  description: string;
  private executor: (input: CrewAgentInput) => Promise<CrewAgentOutput>;

  constructor(opts: {
    name: string;
    description: string;
    executor: (input: CrewAgentInput) => Promise<CrewAgentOutput>;
  }) {
    this.name = opts.name;
    this.description = opts.description;
    this.executor = opts.executor;
  }

  async run(input: CrewAgentInput): Promise<CrewAgentOutput> {
    return this.executor(input);
  }
}
