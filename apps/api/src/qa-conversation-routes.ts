import type { FastifyInstance } from "fastify";

import type {
  QaConversationMessageRecord,
  QaConversationRecord,
  QaPersistedAnalysisRunRecord,
} from "./qa-conversation-repository.js";
import { QA_PERSISTENCE_UNAVAILABLE_MESSAGE } from "./qa-persistence.js";

export interface QaConversationMemoryStore {
  listConversations(projectId: string): Promise<QaConversationRecord[]>;
  createConversation(projectId: string, userId: string, title: string): Promise<QaConversationRecord | null>;
  getConversation(projectId: string, conversationId: string): Promise<QaConversationRecord | null>;
  setPinned(projectId: string, conversationId: string, isPinned: boolean): Promise<QaConversationRecord | null>;
  listMessages(projectId: string, conversationId: string): Promise<QaConversationMessageRecord[] | null>;
  listCompletedAnalyses(projectId: string, conversationId: string): Promise<QaPersistedAnalysisRunRecord[]>;
  addMessage(
    projectId: string,
    conversationId: string,
    authorUserId: string | null,
    role: QaConversationMessageRecord["role"],
    body: string,
  ): Promise<QaConversationMessageRecord | null>;
}

function invalidText(value: unknown, maximum: number): value is never {
  return typeof value !== "string" || !value.trim() || value.length > maximum;
}

/** Registers project-scoped QA memory routes. Authorization is enforced by auth-security route policies. */
export function registerQaConversationRoutes(
  app: FastifyInstance,
  repository: QaConversationMemoryStore | undefined,
): void {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/qa/conversations",
    async (request, reply) => {
      if (!repository) return reply.code(503).send({ error: QA_PERSISTENCE_UNAVAILABLE_MESSAGE });
      return reply.send({ data: await repository.listConversations(request.params.projectId) });
    },
  );

  app.post<{
    Params: { projectId: string };
    Body: { title: string };
  }>(
    "/api/projects/:projectId/qa/conversations",
    async (request, reply) => {
      if (!repository) return reply.code(503).send({ error: QA_PERSISTENCE_UNAVAILABLE_MESSAGE });
      if (invalidText(request.body?.title, 160) || !request.authUser) {
        return reply.code(400).send({ error: "Invalid conversation" });
      }
      const conversation = await repository.createConversation(
        request.params.projectId,
        request.authUser.id,
        request.body.title.trim(),
      );
      return conversation
        ? reply.code(201).send({ data: conversation })
        : reply.code(404).send({ error: "Resource not found" });
    },
  );

  app.get<{
    Params: { projectId: string; conversationId: string };
  }>(
    "/api/projects/:projectId/qa/conversations/:conversationId",
    async (request, reply) => {
      if (!repository) return reply.code(503).send({ error: QA_PERSISTENCE_UNAVAILABLE_MESSAGE });
      const conversation = await repository.getConversation(request.params.projectId, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Resource not found" });
      const [messages, analyses] = await Promise.all([
        repository.listMessages(request.params.projectId, request.params.conversationId),
        repository.listCompletedAnalyses(request.params.projectId, request.params.conversationId),
      ]);
      return reply.send({ data: { conversation, messages: messages ?? [], analyses } });
    },
  );

  app.patch<{
    Params: { projectId: string; conversationId: string };
    Body: { isPinned: boolean };
  }>(
    "/api/projects/:projectId/qa/conversations/:conversationId",
    async (request, reply) => {
      if (!repository) return reply.code(503).send({ error: QA_PERSISTENCE_UNAVAILABLE_MESSAGE });
      if (typeof request.body?.isPinned !== "boolean") {
        return reply.code(400).send({ error: "Invalid conversation update" });
      }
      const conversation = await repository.setPinned(
        request.params.projectId,
        request.params.conversationId,
        request.body.isPinned,
      );
      return conversation
        ? reply.send({ data: conversation })
        : reply.code(404).send({ error: "Resource not found" });
    },
  );

  app.post<{
    Params: { projectId: string; conversationId: string };
    Body: { role: "user" | "assistant"; body: string };
  }>(
    "/api/projects/:projectId/qa/conversations/:conversationId/messages",
    async (request, reply) => {
      if (!repository) return reply.code(503).send({ error: QA_PERSISTENCE_UNAVAILABLE_MESSAGE });
      if (!request.authUser || request.body?.role !== "user" || invalidText(request.body?.body, 8_000)) {
        return reply.code(400).send({ error: "Invalid message" });
      }
      const message = await repository.addMessage(
        request.params.projectId,
        request.params.conversationId,
        request.authUser.id,
        "user",
        request.body.body.trim(),
      );
      return message
        ? reply.code(201).send({ data: message })
        : reply.code(404).send({ error: "Resource not found" });
    },
  );
}
