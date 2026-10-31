import { MongoServerError, type Db } from "mongodb";
import { AgentNameTakenError, type Names } from "../application/agents.ts";

export function mongoNames(db: Db): Names {
  const names = db.collection<{ _id: string; agentId: string }>("agent_names");
  return {
    async claim(name, agentId, session) {
      try {
        await names.insertOne({ _id: name, agentId }, { session });
      } catch (error) {
        if (error instanceof MongoServerError && error.code === 11000) {
          throw new AgentNameTakenError();
        }
        throw error;
      }
    },
    async find(name) {
      return (await names.findOne({ _id: name }))?.agentId;
    },
  };
}
