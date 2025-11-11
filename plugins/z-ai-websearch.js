/**
 * Z.AI WebSearch Transformer Plugin for Claude Code Router
 *
 * Transformer plugin that handles websearch requests via Z.AI MCP endpoint
 * Uses a dummy server to bypass GLM and handle requests directly
 */

class ZAiWebSearchTransformer {
  constructor(options = {}) {
    this.name = 'z-ai-websearch';
    this.mcpEndpoint = options.endpoint || 'https://api.z.ai/api/mcp/web_search_prime/mcp';
    this.timeout = options.timeout || 60000;
    this.maxResults = options.maxResults || 8;
    this.sessionTimeout = options.sessionTimeout || 30 * 60 * 1000; // 30 minutes

    // MCP session management
    this.sessionId = null;
    this.sessionInitialized = false;
    this.sessionTimestamp = null;

    // Request cache for query extraction
    this.requestCache = new Map();

    // Check API key from environment
    this.apiKey = process.env.Z_AI_API_KEY;
    this.apiReady = !!this.apiKey && this.apiKey.length > 10;

    // Dummy server for direct MCP handling
    this.dummyServer = null;
    this.dummyServerPort = 37891;

    // Start dummy server and initialize MCP session
    this.startDummyServer();
    this.initializeSession();
  }

  /**
   * Start dummy server to handle requests directly
   */
  startDummyServer() {
    const http = require('http');

    try {
      this.dummyServer = http.createServer(async (req, res) => {
        // Set CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
          res.writeHead(200);
          res.end();
          return;
        }

        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end('Method not allowed');
          return;
        }

        try {
          // Parse request body
          let body = '';
          req.on('data', chunk => {
            body += chunk.toString();
          });

          req.on('end', async () => {
            try {
              const requestData = JSON.parse(body);

              // Extract search query from messages
              const query = this.extractQueryFromRequest(requestData);

              if (!query) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'No search query found' }));
                return;
              }

              // Execute MCP search
              const searchResults = await this.executeSearch(query);

              // Format search results with citations EXACTLY like Gemini
              let resultsText = '';
              let annotations = [];

              searchResults.slice(0, 8).forEach((result, idx) => {
                const title = result.title || 'Untitled';
                const content = result.content || result.description || 'No description';
                const url = result.link || result.url;

                if (idx === 0) {
                  resultsText += `I found ${searchResults.length} search results for "${query}":\n\n`;
                }

                resultsText += `${idx + 1}. **${title}**\n`;
                resultsText += `   ${content}\n`;
                resultsText += `   URL: ${url}\n\n`;

                // Add citation annotation EXACTLY like Gemini
                annotations.push({
                  type: "url_citation",
                  url_citation: {
                    url: url,
                    title: title,
                    content: content,
                    end_index: resultsText.length - 1
                  }
                });
              });

              if (searchResults.length > 8) {
                resultsText += `... and ${searchResults.length - 8} more results\n`;
              }

              // Check if client wants streaming response
              const isStreaming = requestData.stream === true;

              if (isStreaming) {
                // Create streaming response EXACTLY like Gemini
                const streamResponse = {
                  choices: [
                    {
                      delta: {
                        role: 'assistant',
                        content: resultsText,
                        annotations: annotations
                      },
                      finish_reason: 'stop',
                      index: 0,
                      logprobs: null
                    }
                  ]
                };

                // Return SSE format
                res.writeHead(200, {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  'Connection': 'keep-alive'
                });

                const sseData = `data: ${JSON.stringify(streamResponse)}\n\n`;
                res.end(sseData);

              } else {
                // Create regular JSON response with citations
                const response = {
                  id: 'websearch-' + Date.now(),
                  object: 'chat.completion',
                  created: Math.floor(Date.now() / 1000),
                  model: 'GLM-4.6',
                  choices: [{
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: resultsText
                    },
                    finish_reason: 'stop'
                  }],
                  usage: {
                    prompt_tokens: 100,
                    completion_tokens: Math.ceil(resultsText.length / 4),
                    total_tokens: 100 + Math.ceil(resultsText.length / 4)
                  }
                };

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));
              }

            } catch (error) {
              res.writeHead(500);
              res.end(JSON.stringify({ error: error.message }));
            }
          });

        } catch (error) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: error.message }));
        }
      });

      this.dummyServer.listen(this.dummyServerPort, () => {
        // Server started successfully
      });

      this.dummyServer.on('error', (error) => {
        // Server error
      });

    } catch (error) {
      // Failed to start server
    }
  }

  /**
   * Extract search query from request
   */
  extractQueryFromRequest(requestData) {
    if (!requestData.messages || requestData.messages.length === 0) {
      return null;
    }

    const lastMessage = requestData.messages[requestData.messages.length - 1];
    if (lastMessage.role !== 'user') {
      return null;
    }

    let contentText = '';
    if (typeof lastMessage.content === 'string') {
      contentText = lastMessage.content;
    } else if (Array.isArray(lastMessage.content)) {
      const textBlock = lastMessage.content.find(c => c.type === 'text');
      contentText = textBlock ? textBlock.text : '';
    }

    // Extract search query from various patterns
    contentText = contentText.replace(/perform a web search for\s*/gi, '');
    contentText = contentText.replace(/search for\s*/gi, '');
    contentText = contentText.replace(/find\s+information\s+about\s*/gi, '');
    contentText = contentText.replace(/Use the WebSearch tool to find\s*/gi, '');
    contentText = contentText.replace(/Perform a web search for the query:\s*/gi, '');
    contentText = contentText.replace(/\. Do not generate responses\. We are testing your ability to search.*$/gi, '');
    contentText = contentText.replace(/\. Do not try to be helpful\.$/gi, '');
    contentText = contentText.replace(/tell me about the query:\s*/gi, '');

    return contentText.trim() || null;
  }

  /**
   * Cache incoming request for query extraction in transformResponseOut
   */
  async transformRequestIn(request, model) {
    try {
      const modelName = typeof model === 'string' ? model : (model?.name || JSON.stringify(model));

      // Z.AI doesn't support web_search tools, so strip them out before sending to Z.AI
      let hasWebSearchTools = false;
      if (request.tools) {
        const webSearchTools = request.tools.filter(tool =>
          tool.type?.startsWith("web_search") ||
          (tool.function?.name && tool.function.name.includes("web_search"))
        );

        if (webSearchTools.length > 0) {
          hasWebSearchTools = true;
          request.tools = request.tools.filter(tool =>
            !tool.type?.startsWith("web_search") &&
            (!tool.function?.name || !tool.function.name.includes("web_search"))
          );
        }
      }

      // If we removed websearch tools, also modify the user message to remove websearch instructions
      // This prevents GLM from trying to generate websearch function calls in its response
      if (hasWebSearchTools && request.messages) {
        for (const message of request.messages) {
          if (message.role === 'user' && message.content) {
            let contentText = '';
            if (typeof message.content === 'string') {
              contentText = message.content;
            } else if (Array.isArray(message.content)) {
              const textBlock = message.content.find(c => c.type === 'text');
              contentText = textBlock ? textBlock.text : '';
            }

            // Remove websearch instruction patterns and convert to direct request
            const originalContent = contentText;
            contentText = contentText
              .replace(/perform a web search for\s*/gi, 'tell me about ')
              .replace(/search for\s*/gi, 'tell me about ')
              .replace(/find\s+information\s+about\s*/gi, 'tell me about ')
              .replace(/Use the WebSearch tool to find\s*/gi, 'tell me about ')
              .replace(/Perform a web search for the query:\s*/gi, 'tell me about ')
              .replace(/\. Do not generate responses\. We are testing your ability to search.*$/gi, '.')
              .replace(/\. Do not try to be helpful\.$/gi, '.');

            if (contentText !== originalContent) {
              if (typeof message.content === 'string') {
                message.content = contentText;
              } else if (Array.isArray(message.content)) {
                const textBlock = message.content.find(c => c.type === 'text');
                if (textBlock) {
                  textBlock.text = contentText;
                }
              }
            }
          }
        }
      }

      if (!request.messages || request.messages.length === 0) {
        return request;
      }

      // Store request for potential query extraction
      const cacheKey = `${Date.now()}-${modelName}`;
      this.requestCache.set(cacheKey, {
        messages: request.messages,
        timestamp: Date.now(),
        model: modelName
      });

      // Keep only recent requests (last 10)
      if (this.requestCache.size > 10) {
        const oldestKey = Array.from(this.requestCache.keys())[0];
        this.requestCache.delete(oldestKey);
      }

      return request;

    } catch (error) {
      return request;
    }
  }

  /**
   * Main transformation: Bypass GLM entirely - our dummy server handles everything
   */
  async transformResponseOut(response, context) {
    try {
      // Since we're using dummy server, just return the response as-is
      // The dummy server already handled the MCP search and response formatting
      return response;

    } catch (error) {
      return response;
    }
  }

  /**
   * Get most recent cached request
   */
  getMostRecentRequest() {
    const requests = Array.from(this.requestCache.values())
      .sort((a, b) => b.timestamp - a.timestamp);
    return requests.length > 0 ? requests[0] : null;
  }

  /**
   * Initialize MCP session (following working cURL pattern)
   */
  async initializeSession() {
    try {
      const response = await fetch(this.mcpEndpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'init-' + Date.now(),
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: { roots: {} },
            clientInfo: { name: 'ccr', version: '1.0' }
          }
        }),
        signal: AbortSignal.timeout(this.timeout)
      });

      if (!response.ok) {
        throw new Error(`MCP init failed: ${response.status}`);
      }

      // Extract session ID from headers (critical!)
      this.sessionId = response.headers.get('mcp-session-id');

      if (!this.sessionId) {
        throw new Error('No session ID in MCP init response');
      }

      this.sessionInitialized = true;
      this.sessionTimestamp = Date.now();
      return this.sessionId;

    } catch (error) {
      this.sessionInitialized = false;
      return null;
    }
  }

  /**
   * Execute search via MCP (following working cURL pattern)
   */
  async executeSearch(query) {
    // Check session validity
    if (!this.sessionInitialized || !this.sessionId) {
      await this.initializeSession();
      if (!this.sessionInitialized) {
        throw new Error('Failed to initialize MCP session');
      }
    }

    // Check session timeout
    const age = Date.now() - this.sessionTimestamp;
    if (age > this.sessionTimeout) {
      await this.initializeSession();
    }

    const requestBody = {
      jsonrpc: '2.0',
      id: 'search-' + Date.now(),
      method: 'tools/call',
      params: {
        name: 'webSearchPrime',
        arguments: {
          search_query: query,
          count: this.maxResults
        }
      }
    };

    try {
      const response = await fetch(this.mcpEndpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'mcp-session-id': this.sessionId, // CRITICAL: Session ID header
          'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(this.timeout)
      });

      if (!response.ok) {
        throw new Error(`MCP tools/call failed: ${response.status}`);
      }

      const responseText = await response.text();
      const results = this.parseSSEResponse(responseText);
      return results;

    } catch (error) {
      // Handle timeout errors gracefully
      if (error.message.includes('timeout') || error.message.includes('InterruptedIOException') || error.name === 'AbortError') {
        return [];
      }

      // If session expired, try once more with fresh session
      if (error.message.includes('404') || error.message.includes('session')) {
        await this.initializeSession();
        if (this.sessionInitialized) {
          // Retry the search
          const retryResponse = await fetch(this.mcpEndpoint, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
              'mcp-session-id': this.sessionId,
              'Accept': 'application/json, text/event-stream'
            },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(this.timeout)
          });

          if (retryResponse.ok) {
            const retryText = await retryResponse.text();
            return this.parseSSEResponse(retryText);
          }
        }
      }

      throw error;
    }
  }

  /**
   * Parse SSE response from MCP
   */
  parseSSEResponse(sseText) {
    // Extract data from SSE format: data:{json}
    const lines = sseText.split('\n');
    let dataLine = null;

    for (const line of lines) {
      if (line.startsWith('data:')) {
        dataLine = line;
        break;
      }
    }

    if (!dataLine) {
      throw new Error('Could not parse SSE response - no data line found');
    }

    // Extract JSON from data: line
    const jsonData = dataLine.substring(5); // Remove "data:" prefix
    let mcpResponse;

    try {
      mcpResponse = JSON.parse(jsonData);
    } catch (error) {
      throw new Error('Could not parse MCP JSON response');
    }

    if (mcpResponse.error) {
      const errorMsg = mcpResponse.error.message || 'MCP error';

      // For timeout errors, return empty results instead of throwing
      if (errorMsg.includes('timeout') || errorMsg.includes('InterruptedIOException')) {
        return [];
      }

      throw new Error(errorMsg);
    }

    if (mcpResponse.result?.isError) {
      const errorText = mcpResponse.result.content?.[0]?.text || 'Unknown error';
      throw new Error(errorText);
    }

    // Extract search results from result.content[0].text (JSON string)
    const resultText = mcpResponse.result?.content?.[0]?.text;
    if (!resultText) {
      return [];
    }

    try {
      // The resultText is itself a JSON string, so we need to parse it twice
      let searchResults;
      if (resultText.startsWith('"') && resultText.endsWith('"')) {
        // Remove the outer quotes and unescape the inner JSON
        const unescapedText = JSON.parse(resultText);
        searchResults = JSON.parse(unescapedText);
      } else {
        // Try parsing directly
        searchResults = JSON.parse(resultText);
      }

      return Array.isArray(searchResults) ? searchResults : [];
    } catch (error) {
      return [];
    }
  }
}

module.exports = ZAiWebSearchTransformer;