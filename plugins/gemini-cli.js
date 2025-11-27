const os = require("os");
const path = require("path");
const fs = require("fs/promises");

const OAUTH_FILE = path.join(os.homedir(), ".gemini", "oauth_creds.json");

// Type enum equivalent in JavaScript
const Type = {
  TYPE_UNSPECIFIED: "TYPE_UNSPECIFIED",
  STRING: "STRING",
  NUMBER: "NUMBER",
  INTEGER: "INTEGER",
  BOOLEAN: "BOOLEAN",
  ARRAY: "ARRAY",
  OBJECT: "OBJECT",
  NULL: "NULL",
};

/**
 * Transform the type field from an array of types to an array of anyOf fields.
 * @param {string[]} typeList - List of types
 * @param {Object} resultingSchema - The schema object to modify
 */
function flattenTypeArrayToAnyOf(typeList, resultingSchema) {
  if (typeList.includes("null")) {
    resultingSchema["nullable"] = true;
  }
  const listWithoutNull = typeList.filter((type) => type !== "null");

  if (listWithoutNull.length === 1) {
    const upperCaseType = listWithoutNull[0].toUpperCase();
    resultingSchema["type"] = Object.values(Type).includes(upperCaseType)
      ? upperCaseType
      : Type.TYPE_UNSPECIFIED;
  } else {
    resultingSchema["anyOf"] = [];
    for (const i of listWithoutNull) {
      const upperCaseType = i.toUpperCase();
      resultingSchema["anyOf"].push({
        type: Object.values(Type).includes(upperCaseType)
          ? upperCaseType
          : Type.TYPE_UNSPECIFIED,
      });
    }
  }
}

/**
 * Process a JSON schema to make it compatible with the GenAI API
 * @param {Object} _jsonSchema - The JSON schema to process
 * @returns {Object} - The processed schema
 */
function processJsonSchema(_jsonSchema) {
  const genAISchema = {};
  const schemaFieldNames = ["items"];
  const listSchemaFieldNames = ["anyOf"];
  const dictSchemaFieldNames = ["properties"];

  if (_jsonSchema["type"] && _jsonSchema["anyOf"]) {
    throw new Error("type and anyOf cannot be both populated.");
  }

  /*
  This is to handle the nullable array or object. The _jsonSchema will
  be in the format of {anyOf: [{type: 'null'}, {type: 'object'}]}. The
  logic is to check if anyOf has 2 elements and one of the element is null,
  if so, the anyOf field is unnecessary, so we need to get rid of the anyOf
  field and make the schema nullable. Then use the other element as the new
  _jsonSchema for processing. This is because the backend doesn't have a null
  type.
  */
  const incomingAnyOf = _jsonSchema["anyOf"];
  if (
    incomingAnyOf != null &&
    Array.isArray(incomingAnyOf) &&
    incomingAnyOf.length == 2
  ) {
    if (incomingAnyOf[0] && incomingAnyOf[0]["type"] === "null") {
      genAISchema["nullable"] = true;
      _jsonSchema = incomingAnyOf[1];
    } else if (incomingAnyOf[1] && incomingAnyOf[1]["type"] === "null") {
      genAISchema["nullable"] = true;
      _jsonSchema = incomingAnyOf[0];
    }
  }

  if (_jsonSchema["type"] && Array.isArray(_jsonSchema["type"])) {
    flattenTypeArrayToAnyOf(_jsonSchema["type"], genAISchema);
  }

  for (const [fieldName, fieldValue] of Object.entries(_jsonSchema)) {
    // Skip if the fieldValue is undefined or null.
    if (fieldValue == null) {
      continue;
    }

    if (fieldName == "type") {
      if (fieldValue === "null") {
        throw new Error(
          "type: null can not be the only possible type for the field."
        );
      }
      if (Array.isArray(fieldValue)) {
        // we have already handled the type field with array of types in the
        // beginning of this function.
        continue;
      }
      const upperCaseValue = fieldValue.toUpperCase();
      genAISchema["type"] = Object.values(Type).includes(upperCaseValue)
        ? upperCaseValue
        : Type.TYPE_UNSPECIFIED;
    } else if (schemaFieldNames.includes(fieldName)) {
      genAISchema[fieldName] = processJsonSchema(fieldValue);
    } else if (listSchemaFieldNames.includes(fieldName)) {
      const listSchemaFieldValue = [];
      for (const item of fieldValue) {
        if (item["type"] == "null") {
          genAISchema["nullable"] = true;
          continue;
        }
        listSchemaFieldValue.push(processJsonSchema(item));
      }
      genAISchema[fieldName] = listSchemaFieldValue;
    } else if (dictSchemaFieldNames.includes(fieldName)) {
      const dictSchemaFieldValue = {};
      for (const [key, value] of Object.entries(fieldValue)) {
        dictSchemaFieldValue[key] = processJsonSchema(value);
      }
      genAISchema[fieldName] = dictSchemaFieldValue;
    } else {
      // additionalProperties is not included in JSONSchema, skipping it.
      if (fieldName === "additionalProperties") {
        continue;
      }
      genAISchema[fieldName] = fieldValue;
    }
  }
  return genAISchema;
}

/**
 * Transform a tool object
 * @param {Object} tool - The tool object to transform
 * @returns {Object} - The transformed tool object
 */
function tTool(tool) {
  if (tool.functionDeclarations) {
    for (const functionDeclaration of tool.functionDeclarations) {
      if (functionDeclaration.parameters) {
        if (!Object.keys(functionDeclaration.parameters).includes("$schema")) {
          functionDeclaration.parameters = processJsonSchema(
            functionDeclaration.parameters
          );
        } else {
          if (!functionDeclaration.parametersJsonSchema) {
            functionDeclaration.parametersJsonSchema =
              functionDeclaration.parameters;
            delete functionDeclaration.parameters;
          }
        }
      }
      if (functionDeclaration.response) {
        if (!Object.keys(functionDeclaration.response).includes("$schema")) {
          functionDeclaration.response = processJsonSchema(
            functionDeclaration.response
          );
        } else {
          if (!functionDeclaration.responseJsonSchema) {
            functionDeclaration.responseJsonSchema =
              functionDeclaration.response;
            delete functionDeclaration.response;
          }
        }
      }
    }
  }
  return tool;
}
let thisA, thisB;

class GeminiCLITransformer {
  name = "gemini-cli";

  constructor(options) {
    thisA = this;
    this.options = options;
    try {
      this.oauth_creds = require(OAUTH_FILE);
    } catch {}
  }

  async transformRequestIn(request, provider) {
    if (this.oauth_creds && this.oauth_creds.expiry_date < +new Date()) {
      await this.refreshToken(this.oauth_creds.refresh_token);
    }
    const tools = [];
    const functionDeclarations = request.tools
      ?.filter((tool) => tool.function.name !== "web_search")
      ?.map((tool) => {
        return {
          name: tool.function.name,
          description: tool.function.description,
          parametersJsonSchema: tool.function.parameters,
        };
      });
    if (functionDeclarations?.length) {
      tools.push(
        tTool({
          functionDeclarations,
        })
      );
    }
    const webSearch = request.tools?.find(
      (tool) => tool.function.name === "web_search"
    );
    if (webSearch) {
      tools.push({
        googleSearch: {},
      });
    }

    const contents = [];
    const toolResponses = request.messages.filter(
      (item) => item.role === "tool"
    );
    request.messages
      .filter((item) => item.role !== "tool" && item.role !== "system")
      .forEach((message) => {
        let role;
        if (message.role === "assistant") {
          role = "model";
        } else if (["user"].includes(message.role)) {
          role = "user";
        } else {
          role = "user"; // Default to user if role is not recognized
        }
        const parts = [];
        if (typeof message.content === "string") {
          const part = {
            text: message.content,
          };
          if (message?.thinking?.signature) {
            part.thoughtSignature = message.thinking.signature;
          }
          parts.push(part);
        } else if (Array.isArray(message.content)) {
          parts.push(
            ...message.content.map((content) => {
              if (content.type === "text") {
                return {
                  text: content.text || "",
                };
              }
              if (content.type === "image_url") {
                if (content.image_url.url.startsWith("http")) {
                  return {
                    file_data: {
                      mime_type: content.media_type,
                      file_uri: content.image_url.url,
                    },
                  };
                } else {
                  return {
                    inlineData: {
                      mime_type: content.media_type,
                      data:
                        content.image_url.url?.split(",")?.pop() ||
                        content.image_url.url,
                    },
                  };
                }
              }
            })
          );
        } else if (message.content && typeof message.content === "object") {
          // Object like { text: "..." }
          if (message.content.text) {
            parts.push({ text: message.content.text });
          } else {
            parts.push({ text: JSON.stringify(message.content) });
          }
        }

        if (Array.isArray(message.tool_calls)) {
          parts.push(
            ...message.tool_calls.map((toolCall, index) => {
              return {
                functionCall: {
                  id:
                    toolCall.id ||
                    `tool_${Math.random().toString(36).substring(2, 15)}`,
                  name: toolCall.function.name,
                  args: JSON.parse(toolCall.function.arguments || "{}"),
                },
                thoughtSignature:
                  index === 0 && message.thinking?.signature
                    ? message.thinking?.signature
                    : undefined,
              };
            })
          );
        }

        if (parts.length === 0) {
          parts.push({ text: "" });
        }

        contents.push({
          role,
          parts,
        });

        if (role === "model" && message.tool_calls) {
          const functionResponses = message.tool_calls.map((tool) => {
            const response = toolResponses.find(
              (item) => item.tool_call_id === tool.id
            );
            return {
              functionResponse: {
                name: tool?.function?.name,
                response: { result: response?.content },
              },
            };
          });
          contents.push({
            role: "user",
            parts: functionResponses,
          });
        }
      });

    const generationConfig = {};

    if (
      request.reasoning &&
      request.reasoning.effort &&
      request.reasoning.effort !== "none"
    ) {
      generationConfig.thinkingConfig = {
        includeThoughts: true,
      };
      if (request.model.includes("gemini-3")) {
        generationConfig.thinkingConfig.thinkingLevel =
          request.reasoning.effort;
      } else {
        const thinkingBudgets = request.model.includes("pro")
          ? [128, 32768]
          : [0, 24576];
        let thinkingBudget;
        const max_tokens = request.reasoning.max_tokens;
        if (typeof max_tokens !== "undefined") {
          if (
            max_tokens >= thinkingBudgets[0] &&
            max_tokens <= thinkingBudgets[1]
          ) {
            thinkingBudget = max_tokens;
          } else if (max_tokens < thinkingBudgets[0]) {
            thinkingBudget = thinkingBudgets[0];
          } else if (max_tokens > thinkingBudgets[1]) {
            thinkingBudget = thinkingBudgets[1];
          }
          generationConfig.thinkingConfig.thinkingBudget = thinkingBudget;
        }
      }
    }

    const systemMessages = request.messages
      .filter((msg) => msg.role === "system")
      .map((msg) =>
        typeof msg.content === "string"
          ? [{ text: msg.content }]
          : msg.content.map((part) => ({ text: part.text }))
      );

    const body = {
      contents,
      tools: tools.length ? tools : undefined,
      generationConfig,
      system_instruction: {
        parts: systemMessages,
      },
    };

    if (request.tool_choice) {
      const toolConfig = {
        functionCallingConfig: {},
      };
      if (request.tool_choice === "auto") {
        toolConfig.functionCallingConfig.mode = "auto";
      } else if (request.tool_choice === "none") {
        toolConfig.functionCallingConfig.mode = "none";
      } else if (request.tool_choice === "required") {
        toolConfig.functionCallingConfig.mode = "any";
      } else if (request.tool_choice?.function?.name) {
        toolConfig.functionCallingConfig.mode = "any";
        toolConfig.functionCallingConfig.allowedFunctionNames = [
          request.tool_choice?.function?.name,
        ];
      }
      body.toolConfig = toolConfig;
    }

    return {
      body: {
        request: body,
        model: request.model,
        project: this.options?.project,
      },
      config: {
        url: new URL(
          `https://cloudcode-pa.googleapis.com/v1internal:${
            request.stream ? "streamGenerateContent?alt=sse" : "generateContent"
          }`
        ),
        headers: {
          Authorization: `Bearer ${this.oauth_creds.access_token}`,
          "user-agent": `GeminiCLI/v22.12.0 (darwin; arm64)`,
        },
      },
    };
  }

  async transformResponseOut(response) {
    if (response.headers.get("Content-Type")?.includes("application/json")) {
      let jsonResponse = await response.json();
      jsonResponse = jsonResponse.response;
      // Extract thinking content from parts with thought: true
      let thinkingContent = "";
      let thinkingSignature = "";
      console.log(JSON.stringify(jsonResponse.candidates, null, 2));

      const parts = jsonResponse.candidates[0]?.content?.parts || [];
      const nonThinkingParts = [];

      for (const part of parts) {
        if (part.text && part.thought === true) {
          thinkingContent += part.text;
        } else {
          nonThinkingParts.push(part);
        }
      }

      // Get thoughtSignature from functionCall args or usageMetadata
      thinkingSignature = parts.find(
        (part) => part.thoughtSignature
      )?.thoughtSignature;

      const tool_calls =
        nonThinkingParts
          ?.filter((part) => part.functionCall)
          ?.map((part) => ({
            id:
              part.functionCall?.id ||
              `tool_${Math.random().toString(36).substring(2, 15)}`,
            type: "function",
            function: {
              name: part.functionCall?.name,
              arguments: JSON.stringify(part.functionCall?.args || {}),
            },
          })) || [];

      const textContent =
        nonThinkingParts
          ?.filter((part) => part.text)
          ?.map((part) => part.text)
          ?.join("\n") || "";

      const res = {
        id: jsonResponse.responseId,
        choices: [
          {
            finish_reason:
              jsonResponse.candidates[0].finishReason?.toLowerCase() || null,
            index: 0,
            message: {
              content: textContent,
              role: "assistant",
              tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
              // Add thinking as separate field if available
              ...(thinkingSignature && {
                thinking: {
                  content: thinkingContent || "(no content)",
                  signature: thinkingSignature,
                },
              }),
            },
          },
        ],
        created: parseInt(new Date().getTime() / 1000 + "", 10),
        model: jsonResponse.modelVersion,
        object: "chat.completion",
        usage: {
          completion_tokens: jsonResponse.usageMetadata.candidatesTokenCount,
          prompt_tokens: jsonResponse.usageMetadata.promptTokenCount,
          cached_content_token_count:
            jsonResponse.usageMetadata.cachedContentTokenCount || null,
          total_tokens: jsonResponse.usageMetadata.totalTokenCount,
          thoughts_token_count: jsonResponse.usageMetadata?.thoughtsTokenCount,
        },
      };
      return new Response(JSON.stringify(res), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } else if (response.headers.get("Content-Type")?.includes("stream")) {
      if (!response.body) {
        return response;
      }

      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let signatureSent = false;
      let contentSent = false;
      let hasThinkingContent = false;
      let pendingContent = "";
      let contentIndex = 0;
      let toolCallIndex = -1;

      const stream = new ReadableStream({
        async start(controller) {
          const processLine = async (line, controller) => {
            if (line.startsWith("data: ")) {
              const chunkStr = line.slice(6).trim();
              if (chunkStr) {
                this.logger?.debug({ chunkStr }, `${providerName} chunk:`);
                try {
                  let chunk = JSON.parse(chunkStr);
                  chunk = chunk.response;

                  // Check if chunk has valid structure
                  if (!chunk.candidates || !chunk.candidates[0]) {
                    this.logger?.debug({ chunkStr }, `Invalid chunk structure`);
                    return;
                  }

                  const candidate = chunk.candidates[0];
                  const parts = candidate.content?.parts || [];

                  parts
                    .filter((part) => part.text && part.thought === true)
                    .forEach((part) => {
                      if (!hasThinkingContent) {
                        hasThinkingContent = true;
                      }
                      const thinkingChunk = {
                        choices: [
                          {
                            delta: {
                              role: "assistant",
                              content: null,
                              thinking: {
                                content: part.text,
                              },
                            },
                            finish_reason: null,
                            index: contentIndex,
                            logprobs: null,
                          },
                        ],
                        created: parseInt(new Date().getTime() / 1000 + "", 10),
                        id: chunk.responseId || "",
                        model: chunk.modelVersion || "",
                        object: "chat.completion.chunk",
                        system_fingerprint: "fp_a49d71b8a1",
                      };
                      controller.enqueue(
                        encoder.encode(
                          `data: ${JSON.stringify(thinkingChunk)}\n\n`
                        )
                      );
                    });

                  let signature = parts.find(
                    (part) => part.thoughtSignature
                  )?.thoughtSignature;
                  if (signature && !signatureSent) {
                    if (!hasThinkingContent) {
                      const thinkingChunk = {
                        choices: [
                          {
                            delta: {
                              role: "assistant",
                              content: null,
                              thinking: {
                                content: "(no content)",
                              },
                            },
                            finish_reason: null,
                            index: contentIndex,
                            logprobs: null,
                          },
                        ],
                        created: parseInt(new Date().getTime() / 1000 + "", 10),
                        id: chunk.responseId || "",
                        model: chunk.modelVersion || "",
                        object: "chat.completion.chunk",
                        system_fingerprint: "fp_a49d71b8a1",
                      };
                      controller.enqueue(
                        encoder.encode(
                          `data: ${JSON.stringify(thinkingChunk)}\n\n`
                        )
                      );
                    }
                    const signatureChunk = {
                      choices: [
                        {
                          delta: {
                            role: "assistant",
                            content: null,
                            thinking: {
                              signature,
                            },
                          },
                          finish_reason: null,
                          index: contentIndex,
                          logprobs: null,
                        },
                      ],
                      created: parseInt(new Date().getTime() / 1000 + "", 10),
                      id: chunk.responseId || "",
                      model: chunk.modelVersion || "",
                      object: "chat.completion.chunk",
                      system_fingerprint: "fp_a49d71b8a1",
                    };
                    controller.enqueue(
                      encoder.encode(
                        `data: ${JSON.stringify(signatureChunk)}\n\n`
                      )
                    );
                    signatureSent = true;
                    contentIndex++;
                    if (pendingContent) {
                      const res = {
                        choices: [
                          {
                            delta: {
                              role: "assistant",
                              content: pendingContent,
                            },
                            finish_reason: null,
                            index: contentIndex,
                            logprobs: null,
                          },
                        ],
                        created: parseInt(new Date().getTime() / 1000 + "", 10),
                        id: chunk.responseId || "",
                        model: chunk.modelVersion || "",
                        object: "chat.completion.chunk",
                        system_fingerprint: "fp_a49d71b8a1",
                      };

                      controller.enqueue(
                        encoder.encode(`data: ${JSON.stringify(res)}\n\n`)
                      );

                      pendingContent = "";
                      if (!contentSent) {
                        contentSent = true;
                      }
                    }
                  }

                  const tool_calls = parts
                    .filter((part) => part.functionCall)
                    .map((part) => ({
                      id:
                        part.functionCall?.id ||
                        `ccr_tool_${Math.random()
                          .toString(36)
                          .substring(2, 15)}`,
                      type: "function",
                      function: {
                        name: part.functionCall?.name,
                        arguments: JSON.stringify(
                          part.functionCall?.args || {}
                        ),
                      },
                    }));

                  const textContent = parts
                    .filter((part) => part.text && part.thought !== true)
                    .map((part) => part.text)
                    .join("\n");

                  if (!textContent && signatureSent && !contentSent) {
                    const emptyContentChunk = {
                      choices: [
                        {
                          delta: {
                            role: "assistant",
                            content: "(no content)",
                          },
                          index: contentIndex,
                          finish_reason: null,
                          logprobs: null,
                        },
                      ],
                      created: parseInt(new Date().getTime() / 1000 + "", 10),
                      id: chunk.responseId || "",
                      model: chunk.modelVersion || "",
                      object: "chat.completion.chunk",
                      system_fingerprint: "fp_a49d71b8a1",
                    };
                    controller.enqueue(
                      encoder.encode(
                        `data: ${JSON.stringify(emptyContentChunk)}\n\n`
                      )
                    );

                    if (!contentSent) {
                      contentSent = true;
                    }
                  }

                  if (textContent && !signatureSent) {
                    pendingContent += textContent;
                    return;
                  }

                  if (textContent) {
                    if (!pendingContent) contentIndex++;
                    const res = {
                      choices: [
                        {
                          delta: {
                            role: "assistant",
                            content: textContent,
                          },
                          finish_reason:
                            candidate.finishReason?.toLowerCase() || null,
                          index: contentIndex,
                          logprobs: null,
                        },
                      ],
                      created: parseInt(new Date().getTime() / 1000 + "", 10),
                      id: chunk.responseId || "",
                      model: chunk.modelVersion || "",
                      object: "chat.completion.chunk",
                      system_fingerprint: "fp_a49d71b8a1",
                      usage: {
                        completion_tokens:
                          chunk.usageMetadata?.candidatesTokenCount || 0,
                        prompt_tokens:
                          chunk.usageMetadata?.promptTokenCount || 0,
                        cached_content_token_count:
                          chunk.usageMetadata?.cachedContentTokenCount || null,
                        total_tokens: chunk.usageMetadata?.totalTokenCount || 0,
                        thoughts_token_count:
                          chunk.usageMetadata?.thoughtsTokenCount,
                      },
                    };

                    if (candidate?.groundingMetadata?.groundingChunks?.length) {
                      res.choices[0].delta.annotations =
                        candidate.groundingMetadata.groundingChunks.map(
                          (groundingChunk, index) => {
                            const support =
                              candidate?.groundingMetadata?.groundingSupports?.filter(
                                (item) =>
                                  item.groundingChunkIndices?.includes(index)
                              );
                            return {
                              type: "url_citation",
                              url_citation: {
                                url: groundingChunk?.web?.uri || "",
                                title: groundingChunk?.web?.title || "",
                                content: support?.[0]?.segment?.text || "",
                                start_index:
                                  support?.[0]?.segment?.startIndex || 0,
                                end_index: support?.[0]?.segment?.endIndex || 0,
                              },
                            };
                          }
                        );
                    }
                    controller.enqueue(
                      encoder.encode(`data: ${JSON.stringify(res)}\n\n`)
                    );

                    if (!contentSent && textContent) {
                      contentSent = true;
                    }
                  }

                  if (tool_calls.length > 0) {
                    tool_calls.forEach((tool) => {
                      contentIndex++;
                      toolCallIndex++;
                      const res = {
                        choices: [
                          {
                            delta: {
                              role: "assistant",
                              tool_calls: [
                                {
                                  ...tool,
                                  index: toolCallIndex,
                                },
                              ],
                            },
                            finish_reason:
                              candidate.finishReason?.toLowerCase() || null,
                            index: contentIndex,
                            logprobs: null,
                          },
                        ],
                        created: parseInt(new Date().getTime() / 1000 + "", 10),
                        id: chunk.responseId || "",
                        model: chunk.modelVersion || "",
                        object: "chat.completion.chunk",
                        system_fingerprint: "fp_a49d71b8a1",
                      };

                      if (
                        candidate?.groundingMetadata?.groundingChunks?.length
                      ) {
                        res.choices[0].delta.annotations =
                          candidate.groundingMetadata.groundingChunks.map(
                            (groundingChunk, index) => {
                              const support =
                                candidate?.groundingMetadata?.groundingSupports?.filter(
                                  (item) =>
                                    item.groundingChunkIndices?.includes(index)
                                );
                              return {
                                type: "url_citation",
                                url_citation: {
                                  url: groundingChunk?.web?.uri || "",
                                  title: groundingChunk?.web?.title || "",
                                  content: support?.[0]?.segment?.text || "",
                                  start_index:
                                    support?.[0]?.segment?.startIndex || 0,
                                  end_index:
                                    support?.[0]?.segment?.endIndex || 0,
                                },
                              };
                            }
                          );
                      }
                      controller.enqueue(
                        encoder.encode(`data: ${JSON.stringify(res)}\n\n`)
                      );
                    });

                    if (!contentSent && textContent) {
                      contentSent = true;
                    }
                  }
                } catch (error) {
                  this.logger?.error(
                    `Error parsing ${providerName} stream chunk`,
                    chunkStr,
                    error.message
                  );
                }
              }
            }
          };

          const reader = response.body.getReader();
          let buffer = "";
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                if (buffer) {
                  await processLine(buffer, controller);
                }
                break;
              }

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");

              buffer = lines.pop() || "";

              for (const line of lines) {
                await processLine(line, controller);
              }
            }
          } catch (error) {
            controller.error(error);
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    return response;
  }

  refreshToken(refresh_token) {
    return fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id:
          "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
        client_secret: "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",
        refresh_token: refresh_token,
        grant_type: "refresh_token",
      }),
    })
      .then((response) => response.json())
      .then(async (data) => {
        data.expiry_date =
          new Date().getTime() + data.expires_in * 1000 - 1000 * 60;
        data.refresh_token = refresh_token;
        delete data.expires_in;
        console.log("this.oauth_creds before: ", this.oauth_creds);
        this.oauth_creds = data;
        console.log("this.oauth_creds after: ", this.oauth_creds);
        await fs.writeFile(OAUTH_FILE, JSON.stringify(data, null, 2));
      });
  }
}

module.exports = GeminiCLITransformer;
