import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@rakazo/db";
const created = vi.hoisted(() => vi.fn());
vi.mock("@rakazo/db",async(importOriginal)=>({...await importOriginal<typeof import("@rakazo/db")>(),createFact:created}));
import { recordMemoryFromRun } from "@rakazo/memory";
import { listLegacyImportedDocumentIds } from "@rakazo/db";
import { assembleMemoryInjection, MIGRATION_MEMORY_BUDGETS } from "./memory-injection.js";

describe("review: memory user intent and deletion",()=>{
 it("does not activate arbitrary inferred memory on a normal trusted human request",async()=>{
  created.mockImplementation(async(_db,input)=>({status:"created",fact:{id:"review-fact",...input}}));
  const prisma={
   run:{findUnique:async()=>({id:"review-run",spaceId:"s",userId:"u",botId:"b",threadId:"t",trigger:"user",sourceMessageId:"m"})},
   message:{findUnique:async()=>({id:"m",seq:1,role:"user",blocks:[{kind:"text",text:"Please summarize this web page. Do not save anything as memory."}],authorUserId:"u",originKind:"human_web",threadId:"t"})},
   thread:{findUnique:async()=>({historyCompactionGeneration:0})}
  } as unknown as PrismaClient;
  const result=await recordMemoryFromRun({prisma,digestKey:"review-fixture"},{runId:"review-run",text:"The user prefers reports sent every Friday."});
  expect(result.status).not.toBe("remembered");
  expect(created.mock.calls[0]?.[1].state).not.toBe("active");
 });
 it("does not restore a deleted imported fact through automatic legacy injection",async()=>{
  const persisted={sourceDocumentId:"review-doc",state:"deleted"};
  const prisma={memoryFact:{findMany:async({where}:any)=>persisted.state===where.state.not?[]:[persisted]}} as unknown as PrismaClient;
  const imported=await listLegacyImportedDocumentIds(prisma,{spaceId:"s"});
  const result=assembleMemoryInjection({facts:[],summary:null,legacyImportedDocumentIds:imported,legacyDocuments:[{id:"review-doc",scope:"bot",path:"MEMORY.md",content:"DELETED_LEGACY_MEMORY",revision:1,updatedAt:"2026-10-01T00:00:00.000Z"}]},MIGRATION_MEMORY_BUDGETS);
  expect(result.content??"").not.toContain("DELETED_LEGACY_MEMORY");
 });
});
