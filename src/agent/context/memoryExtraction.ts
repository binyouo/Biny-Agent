/** 对话记忆提取、临时记忆清理指令及容错操作数组协议。 */
import { parse, disableErrorLogging } from "best-effort-json-parser";

disableErrorLogging();

export const memoryTimeAnchorInstruction = "Preserve original message sent-at timestamps and known timezones. Resolve relative dates against the ORIGINAL message, never memory creation/access/update time or today's date. For time-sensitive memories, include the original source sent-at and timezone in the content when known. Store event, planned deadline and actual completion dates separately in the memory content. A promise or planned action is not completion. Importing an old record does not make its event recent. Preserve these distinctions when checking duplicates or synthesizing memories. Unknown source dates/timezones must remain unknown; do not infer them from memory saved-at.";

export const memoryExtractionPrompt = "You are a memory management assistant. Your task is to extract ONLY truly important, reusable information that will be valuable across multiple future conversations.\n\n## Core Principle: Quality Over Quantity\n\n**Ask yourself before adding any memory:**\n- Will this information be useful in future conversations?\n- Is this a stable fact about the user, not a fleeting detail?\n- Would a personal assistant find this worth remembering long-term?\n\n**DO NOT extract:**\n- Trivial details from the current task (e.g., \"User is generating an image of a cat\", \"Current request involves a winking smile\")\n- One-time requests or transient context\n- Information only relevant to the current conversation\n- Implementation details of what the AI is currently doing\n- Temporary states that will be irrelevant in minutes\n\n## Memory Operations\n\n### ADD - New memories to store (BE VERY SELECTIVE)\n\n**Permanent memories** (high value, stable over time):\n- User identity: name, profession, location, native language\n- Core preferences: communication style, technical preferences, aesthetic tastes\n- Important relationships: family members, colleagues mentioned repeatedly\n- Long-term goals and values\n- Expertise areas or learning goals\n- Recurring workflows or tools they use\n\n**Temporary memories** (use sparingly, only for ongoing multi-session projects):\n- Major projects spanning multiple conversations\n- Important deadlines or time-sensitive commitments\n- Temporary life situations (e.g., \"User is preparing for a job interview next month\")\n\n### DELETE - Memories to remove\n\nDetect explicit requests to forget:\n- \"Forget that I...\", \"Delete the memory about...\", \"Don't remember...\"\n- \"That's no longer true\", \"I was wrong about...\"\n- Corrections that invalidate previous information\n\n**For DELETE**: Use specific keywords to match stored memories:\n- \"forget where I'm from\" → \"User is from\" or \"User's hometown\"\n- \"forget my job\" → \"User works as\" or \"User's occupation\"\n\n## What to Extract (for ADD)\n\nONLY extract information that:\n1. Reveals WHO the user is (identity, preferences, background)\n2. Indicates WHAT the user cares about long-term (goals, values, interests)\n3. Shows HOW the user prefers to work (communication style, tools, workflows)\n4. Represents STABLE facts unlikely to change soon\n\n## What NOT to Extract\n\n- Current task details: \"User wants to add a button\", \"Request is for blue color\"\n- Session-specific context: \"User is debugging an error\", \"Current conversation about X\"\n- Transient states: \"User seems frustrated\", \"User is in a hurry\"\n- AI actions: \"Generating image with parameters...\", \"Currently helping with...\"\n- One-off requests that won't recur\n\n## Guidelines\n\n- **Default to NO_MEMORY** - most conversations don't contain memorable information\n- A typical conversation should yield 0-2 memories at most\n- Permanent memories are rare and valuable; be very selective\n- Temporary memories should only be for significant ongoing projects\n- When in doubt, don't add the memory\n\n## Response Format\n\nRespond with a JSON array of memory operation objects, or [\"NO_MEMORY\"] if nothing worth remembering.\n\nEach object should have:\n- \"operation\": either \"add\" or \"delete\"\n- \"content\": the memory text (for add) or description of memory to delete (for delete)\n- \"durability\": \"permanent\" or \"temporary\" (only required for \"add\" operation)\n\nExample of GOOD memories:\n[\n  {\"operation\": \"add\", \"content\": \"User is a backend developer who prefers Go over Python\", \"durability\": \"permanent\"},\n  {\"operation\": \"add\", \"content\": \"User's name is Alex and works at a fintech startup\", \"durability\": \"permanent\"}\n]\n\nExample of BAD memories (DO NOT create these):\n- \"User is asking about image generation\" (transient task)\n- \"Current request involves a character with a winking smile\" (trivial detail)\n- \"User wants to fix a bug in their code\" (session-specific)\n- \"Conversation is about React components\" (not reusable)";

export const temporaryMemoryCleanupPrompt = "You are a memory cleanup assistant. Your task is to analyze temporary memories and determine which ones should be deleted based on the current conversation context.\n\n## Context\nYou will be given:\n1. A list of temporary memories with their IDs, creation times, and content\n2. The current conversation topic/context\n3. The current date and time\n\n## Decision Criteria\n\nA temporary memory should be DELETED if:\n- It is no longer relevant to the user's current activities or interests\n- The event/project it refers to has likely passed or been completed\n- It contradicts or is superseded by newer information\n- It's about a time-sensitive matter that has expired (e.g., \"interview tomorrow\" when tomorrow has passed)\n- The conversation shows the user has moved on to different topics/projects\n\nA temporary memory should be KEPT if:\n- It's still potentially relevant to ongoing work\n- The time-sensitive information is still in the future\n- There's no indication the project/situation has concluded\n- It provides useful context for the current conversation\n\n## Response Format\n\nRespond with ONLY a JSON array of memory IDs that should be deleted.\n- If no memories should be deleted, respond with []\n- Example: [\"abc123\", \"def456\"] means delete memories with those IDs\n\nBe conservative - when in doubt, keep the memory. Only delete memories that are clearly outdated or irrelevant.";

export interface MemoryOperation {
  content: string;
  operation: "add" | "delete";
  durability: "permanent" | "temporary";
}

export interface ExtractedMemory {
  id: string;
  content: string;
}

export function parseMemoryOperations(response: string): MemoryOperation[] {
  const text = response.trim();
  const array = text.match(/\[[\s\S]*\]/u);
  if (array) {
    try {
      const parsed: unknown = parse(array[0]);
      if (Array.isArray(parsed)) {
        const operations: MemoryOperation[] = [];
        for (const item of parsed) {
          if (typeof item === "string" && item !== "NO_MEMORY") {
            operations.push({ content: item, operation: "add", durability: "permanent" });
          } else if (typeof item === "object" && item !== null && typeof item.content === "string" && item.content !== "NO_MEMORY") {
            operations.push({ content: item.content, operation: item.operation === "delete" ? "delete" : "add", durability: item.durability === "temporary" ? "temporary" : "permanent" });
          }
        }
        if (operations.length) return operations;
      }
    } catch {
      // 无法恢复的数组不降级成普通记忆，避免把损坏协议写入事实库。
    }
  }
  return text.includes("NO_MEMORY") || text.includes("[") ? [] : [{ content: text, operation: "add", durability: "permanent" }];
}
