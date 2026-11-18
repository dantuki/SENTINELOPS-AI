import type { FastifyInstance } from "fastify";

import {
  answerQaQuestion,
  assistantResponseForHistory,
  type QaAssistantGenerationProvider,
} from "./qa-assistant.js";
import type {
  QaConversationMessageRecord,
  QaConversationRecord,
  QaConversationRepository,
  QaPersistedAnalysisRunRecord,
} from "./qa-conversation-repository.js";

interface QaAssistantStore {
  getConversation(projectId: string, conversationId: string): Promise<QaConversationRecord | null>;
  listCompletedAnalyses(projectId: string, conversationId: string): Promise<QaPersistedAnalysisRunRecord[]>;
  addMessage(
    projectId: string,
    conversationId: string,
    authorUserId: string | null,
    role: QaConversationMessageRecord["role"],
    body: string,
  ): Promise<QaConversationMessageRecord | null>;
}

interface QaAssistantRouteOptions {
  conversationStore?: Pick<
    QaConversationRepository,
    "getConversation" | "listCompletedAnalyses" | "addMessage"
  >;
  generationProvider?: QaAssistantGenerationProvider;
}

const requestSchema = {
  type: "object",
  properties: {
    analysisRunId: { type: "string", format: "uuid" },
    question: { type: "string", minLength: 1, maxLength: 2000 },
  },
  required: ["analysisRunId", "question"],
  additionalProperties: false,
} as const;

function validQuestion(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 2000;
}

/** Project-scoped evidence-grounded QA conversation endpoint. */
export function registerQaAssistantRoutes(app: FastifyInstance, options: QaAssistantRouteOptions = {}): void {
  const store: QaAssistantStore | undefined = options.conversationStore;
  app.post<{
    Params: { projectId: string; conversationId: string };
    Body: { analysisRunId: string; question: string };
  }>(
    "/api/projects/:projectId/qa/conversations/:conversationId/assistant",
    { schema: { body: requestSchema } },
    async (request, reply) => {
      if (!store) return reply.code(503).send({ error: "QA memory unavailable" });
      if (!request.authUser || !validQuestion(request.body?.question)) {
        return reply.code(400).send({ error: "Invalid question" });
      }
      const conversation = await store.getConversation(request.params.projectId, request.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "Resource not found" });
      const analyses = await store.listCompletedAnalyses(request.params.projectId, request.params.conversationId);
      const analysis = analyses.find((candidate) => candidate.id === request.body.analysisRunId);
      if (!analysis) return reply.code(404).send({ error: "Resource not found" });

      const answer = await answerQaQuestion({
        analysis,
        question: request.body.question.trim(),
        ...(options.generationProvider ? { provider: options.generationProvider } : {}),
      });
      const userMessage = await store.addMessage(
        request.params.projectId,
        conversation.id,
        request.authUser.id,
        "user",
        request.body.question.trim(),
      );
      const assistantMessage = await store.addMessage(
        request.params.projectId,
        conversation.id,
        null,
        "assistant",
        assistantResponseForHistory(answer),
      );
      if (!userMessage || !assistantMessage) {
        return reply.code(503).send({ error: "No se pudo confirmar la persistencia de la respuesta." });
      }
      return reply.code(200).send({
        data: { answer, messages: { user: userMessage, assistant: assistantMessage } },
      });
    },
  );
}
