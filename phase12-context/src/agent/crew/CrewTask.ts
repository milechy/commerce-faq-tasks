// src/agent/crew/CrewTask.ts

import type { CrewAgent, CrewAgentInput, CrewAgentOutput } from "./CrewAgent";

export class CrewTask {
  name: string;
  agent: CrewAgent;
  goal: string;

  constructor(opts: { name: string; agent: CrewAgent; goal: string }) {
    this.name = opts.name;
    this.agent = opts.agent;
    this.goal = opts.goal;
  }

  async run(input: CrewAgentInput): Promise<CrewAgentOutput> {
    return this.agent.run({
      ...input,
      context: {
        goal: this.goal,
      },
    });
  }
}
