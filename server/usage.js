import { randomUUID } from 'node:crypto';

const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

// Keep missing provider fields unknown. SDK-normalized zeroes are not evidence
// that a provider reported zero usage.
export function readUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const inputTokens = number(raw.input_tokens ?? raw.inputTokens);
  const outputTokens = number(raw.output_tokens ?? raw.outputTokens);
  const totalTokens = number(raw.total_tokens ?? raw.totalTokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  if (inputTokens === null && outputTokens === null && totalTokens === null) return null;
  const input = raw.input_tokens_details ?? raw.inputTokensDetails ?? {};
  const output = raw.output_tokens_details ?? raw.outputTokensDetails ?? {};
  return { inputTokens, outputTokens, totalTokens,
    cachedTokens: number(input.cached_tokens), textInputTokens: number(input.text_tokens),
    imageInputTokens: number(input.image_tokens), reasoningTokens: number(output.reasoning_tokens) };
}

export function startUsage(job, kind, model) {
  const call = { id: randomUUID(), kind, requestedModel: model, startedAt: new Date().toISOString(), status: 'running', usage: null };
  (job.usage ||= []).push(call);
  return call;
}

export function finishUsage(call, response, status = 'completed') {
  call.finishedAt = new Date().toISOString();
  call.durationMs = Date.parse(call.finishedAt) - Date.parse(call.startedAt);
  call.status = status;
  call.usage = readUsage(response?.usage);
  if (typeof response?._request_id === 'string') call.requestId = response._request_id;
  if (typeof response?.id === 'string') call.responseId = response.id;
  if (typeof response?.model === 'string') call.responseModel = response.model;
}

export function finishAgentUsage(call, result, status = 'completed') {
  finishUsage(call, null, status);
  // preserveRawUsage is enabled on the Agent; do not fall back to the SDK's
  // normalized Usage object, which fills omitted provider usage with zeroes.
  if(result?.rawResponses?.length){
    call.responses=[];
    for(const response of result.rawResponses)recordAgentResponse(call,response);
  }else call.responses ||= [];
}

export function recordAgentResponse(call, response) {
  (call.responses ||= []).push({responseId:response.responseId||null,requestId:response.requestId||null,usage:readUsage(response.rawUsage)});
}
