import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI } from "@google/genai";
import { db } from "./firebase.js";
import { GEMINI_MODEL } from "./config.js";
import { httpError } from "./errors.js";
import { getCurrentPlan, getMonthlyUsageDoc, currentMonthKey } from "./billing/users.js";

const genai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

export async function generateJson(
  userId: string,
  input: { contents: string; temperature: number; maxOutputTokens: number },
) {
  ensureGemini();
  await reserveAiRequest(userId);

  const response = await genai!.models.generateContent({
    model: GEMINI_MODEL,
    contents: input.contents,
    config: {
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
      responseMimeType: "application/json",
    },
  });

  const text = response.text?.trim();
  if (!text) throw httpError(502, "Empty response from AI provider.");

  await getMonthlyUsageDoc(userId).set(
    {
      outputTokens: FieldValue.increment(Number(response.usageMetadata?.candidatesTokenCount ?? 0)),
      inputTokens: FieldValue.increment(Number(response.usageMetadata?.promptTokenCount ?? 0)),
      totalTokens: FieldValue.increment(Number(response.usageMetadata?.totalTokenCount ?? 0)),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  try {
    return { json: JSON.parse(text) };
  } catch {
    throw httpError(502, "AI provider returned invalid JSON.");
  }
}

async function reserveAiRequest(userId: string) {
  const usageRef = getMonthlyUsageDoc(userId);
  const plan = await getCurrentPlan(userId);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(usageRef);
    const aiRequests = Number(snapshot.data()?.aiRequests ?? 0);

    if (!plan.adminAccess && aiRequests >= plan.aiRequestsPerMonth) {
      throw httpError(402, "AI monthly limit reached. Upgrade the plan or wait for the next month.");
    }

    transaction.set(
      usageRef,
      {
        userId,
        month: currentMonthKey(),
        aiRequests: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
}

function ensureGemini() {
  if (!genai) throw httpError(500, "GEMINI_API_KEY is not configured.");
}

const CATEGORY_LIST =
  "health, career, learning, finance, relationships, home, leisure, other";
const PRIORITY_LIST = "low, medium, high";

export const PARSE_TASKS_SYSTEM = `You are a task extraction assistant. Extract tasks from the user's natural language input.
Return a JSON object with a "tasks" array. Each task has:
- title: string
- priority: one of ${PRIORITY_LIST}
- time: number duration in minutes, 0 if not specified
- category: one of ${CATEGORY_LIST} or null
Handle Ukrainian and English. Return ONLY valid JSON, no markdown.`;

export const ADVISOR_ADVICE_ONLY_SYSTEM = `Ти - помічник з планування часу та продуктивності. Відповідай українською, коротко та зрозуміло. Поверни JSON лише з полем "advice" - текст поради без markdown.`;

export const ADVISOR_TASKS_ONLY_SYSTEM = `Ти формуєш список задач на основі поради. Поверни JSON лише з полем "tasks" - масив задач. Кожна задача: title, priority ("low"|"medium"|"high"), time (тривалість у хвилинах), category з [${CATEGORY_LIST}] або null, whenDo - масив 1-7 опційно.`;
