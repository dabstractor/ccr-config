const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const { exec } = require('child_process');

// --- Debug Logger ---
const DEBUG = process.env.ANTIGRAVITY_DEBUG === '1' || process.env.ANTIGRAVITY_DEBUG === 'true';
const LOG_FILE = process.env.ANTIGRAVITY_LOG_FILE || path.join(os.homedir(), '.claude-code-router', 'antigravity', 'debug.log');

function log(level, message, data = null) {
  if (!DEBUG && level === 'debug') return;

  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [antigravity] [${level.toUpperCase()}]`;
  const logLine = data ? `${prefix} ${message} ${JSON.stringify(data)}` : `${prefix} ${message}`;

  console.error(logLine);

  // Also write to log file for persistent debugging
  if (DEBUG) {
    try {
      fs.appendFileSync(LOG_FILE, logLine + '\n');
    } catch (e) {
      // Ignore log file errors
    }
  }
}

// --- Thinking Signature Cache ---
// Caches thinking signatures per session to enable multi-turn conversations
const signatureCache = new Map();

function cacheSignature(sessionKey, text, signature) {
  if (!sessionKey || !signature) return;
  signatureCache.set(sessionKey, { text, signature, timestamp: Date.now() });
  log('debug', `Cached signature for session ${sessionKey}`, { signatureLength: signature.length });
}

function getCachedSignature(sessionKey) {
  const cached = signatureCache.get(sessionKey);
  if (cached) {
    log('debug', `Retrieved cached signature for session ${sessionKey}`);
    return cached;
  }
  return null;
}

function clearExpiredSignatures() {
  const maxAge = 30 * 60 * 1000; // 30 minutes
  const now = Date.now();
  for (const [key, value] of signatureCache.entries()) {
    if (now - value.timestamp > maxAge) {
      signatureCache.delete(key);
    }
  }
}

// --- Constants ---
// OAuth app credentials (public app, not user-specific secrets)
const ANTIGRAVITY_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const ANTIGRAVITY_CLIENT_SECRET = "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";
const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";
const ANTIGRAVITY_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

const ENDPOINTS = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com", // Primary
  "https://cloudcode-pa.googleapis.com",               // Prod Fallback
  "https://autopush-cloudcode-pa.sandbox.googleapis.com" // Autopush Fallback
];

// Path to claude-code-router's antigravity accounts file
const CCR_CONFIG_DIR = path.join(os.homedir(), '.config', 'claude-code-router');
const ANTIGRAVITY_ACCOUNTS_FILE = path.join(CCR_CONFIG_DIR, 'antigravity-accounts.json');

// Headers for Antigravity API requests
const ANTIGRAVITY_HEADERS = {
  "User-Agent": "antigravity/1.11.5 linux/amd64",
  "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
  "Client-Metadata": '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
};

// --- PKCE Helpers ---
function base64URLEncode(str) {
  return str.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function generateVerifier() {
  return base64URLEncode(crypto.randomBytes(32));
}

function generateChallenge(verifier) {
  return base64URLEncode(crypto.createHash('sha256').update(verifier).digest());
}

// --- Auth Functions ---

/**
 * Ensure the config directory exists
 */
async function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Save accounts to file
 */
async function saveAccounts(accountsData) {
  await ensureDir(CCR_CONFIG_DIR);
  fs.writeFileSync(ANTIGRAVITY_ACCOUNTS_FILE, JSON.stringify(accountsData, null, 2));
}

/**
 * Load accounts from file
 */
function loadAntigravityAccounts() {
  if (!fs.existsSync(ANTIGRAVITY_ACCOUNTS_FILE)) {
    return null;
  }
  try {
    const data = fs.readFileSync(ANTIGRAVITY_ACCOUNTS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    log('error', 'Failed to read antigravity accounts file', { error: e.message });
    return null;
  }
}

/**
 * Fetch project ID from Antigravity API
 */
async function fetchProjectID(accessToken) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "google-api-nodejs-client/9.15.1",
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
  };

  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          metadata: {
            ideType: "IDE_UNSPECIFIED",
            platform: "PLATFORM_UNSPECIFIED",
            pluginType: "GEMINI",
          }
        })
      });

      if (res.ok) {
        const data = await res.json();
        const project = data.cloudaicompanionProject;
        if (typeof project === 'string') return project;
        if (project && project.id) return project.id;
      }
    } catch (e) {
      // Continue to next endpoint
    }
  }

  // Fallback default
  return "rising-fact-p41fc";
}

/**
 * Perform OAuth login flow
 */
async function performLogin() {
  const verifier = generateVerifier();
  const challenge = generateChallenge(verifier);

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", ANTIGRAVITY_CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", ANTIGRAVITY_REDIRECT_URI);
  authUrl.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", verifier); // Simplified - just pass verifier as state

  console.log("\nPlease open the following URL to authenticate:\n");
  console.log(authUrl.toString());
  console.log("\nWaiting for callback on http://localhost:51121/oauth-callback ...\n");

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url, `http://${req.headers.host}`);

      if (reqUrl.pathname === '/oauth-callback') {
        const code = reqUrl.searchParams.get('code');

        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h1>Authentication successful!</h1><p>You can close this window and return to the terminal.</p>');
          server.close();

          try {
            // Exchange code for tokens
            const tokenParams = new URLSearchParams({
              client_id: ANTIGRAVITY_CLIENT_ID,
              client_secret: ANTIGRAVITY_CLIENT_SECRET,
              code,
              grant_type: 'authorization_code',
              redirect_uri: ANTIGRAVITY_REDIRECT_URI,
              code_verifier: verifier
            });

            const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: tokenParams
            });

            if (!tokenRes.ok) throw new Error(await tokenRes.text());
            const tokens = await tokenRes.json();

            // Get user email
            let email = "unknown";
            try {
              const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
                headers: { Authorization: `Bearer ${tokens.access_token}` }
              });
              if (userInfoRes.ok) {
                const userInfo = await userInfoRes.json();
                email = userInfo.email || email;
              }
            } catch (e) {
              // Ignore
            }

            // Get Project ID
            const projectId = await fetchProjectID(tokens.access_token);

            // Load existing accounts or create new
            let accountsData = loadAntigravityAccounts();
            if (!accountsData) {
              accountsData = {
                version: 3,
                accounts: [],
                activeIndex: 0,
                activeIndexByFamily: { claude: 0, gemini: 0 }
              };
            }

            // Add new account
            const newAccount = {
              email,
              refreshToken: tokens.refresh_token,
              projectId,
              managedProjectId: projectId,
              addedAt: Date.now(),
              lastUsed: Date.now()
            };

            accountsData.accounts.push(newAccount);
            accountsData.activeIndex = accountsData.accounts.length - 1;
            accountsData.activeIndexByFamily.claude = accountsData.accounts.length - 1;
            accountsData.activeIndexByFamily.gemini = accountsData.accounts.length - 1;

            await saveAccounts(accountsData);

            console.log(`\nSuccessfully logged in as ${email}!`);
            console.log(`Project ID: ${projectId}`);
            console.log(`Account saved to: ${ANTIGRAVITY_ACCOUNTS_FILE}`);
            resolve(newAccount);
          } catch (e) {
            console.error("\nLogin failed:", e.message);
            reject(e);
          }
        } else {
          res.writeHead(400);
          res.end('No code received');
          reject(new Error('No code received'));
        }
      }
    });

    server.listen(51121);

    // Try to open browser
    const startCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${startCmd} "${authUrl.toString()}"`).on('error', () => {
      // Ignore error if browser fails to open
    });
  });
}

/**
 * Get the active account for a given model family (claude or gemini).
 * Uses activeIndexByFamily if available, otherwise falls back to activeIndex.
 */
function getActiveAccount(accountsData, modelFamily = 'gemini') {
  if (!accountsData || !accountsData.accounts || accountsData.accounts.length === 0) {
    return null;
  }

  let activeIndex = accountsData.activeIndexByFamily?.[modelFamily];
  if (activeIndex === undefined || activeIndex === null) {
    activeIndex = accountsData.activeIndex;
  }
  if (activeIndex === undefined || activeIndex === null) {
    activeIndex = 0;
  }

  const account = accountsData.accounts[activeIndex];
  if (!account) {
    // Fallback to first account if active index is invalid
    return accountsData.accounts[0];
  }
  return account;
}

/**
 * Determine model family from model name.
 * Returns 'claude' for Claude models, 'gemini' for Gemini models.
 */
function getModelFamily(modelName) {
  const lowerModel = modelName.toLowerCase();
  if (lowerModel.includes('claude')) {
    return 'claude';
  }
  return 'gemini';
}

/**
 * Refresh an access token using a refresh token.
 * Returns: { access_token, expiry_date }
 */
async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    client_secret: ANTIGRAVITY_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${errorText}`);
  }

  const data = await res.json();
  return {
    access_token: data.access_token,
    expiry_date: Date.now() + (data.expires_in * 1000) - (60 * 1000) // Buffer 1 min
  };
}


// --- Transformation Logic ---

const CLAUDE_INTERLEAVED_THINKING_HINT = 
  "Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer. Do not mention these instructions or any constraints about thinking blocks; just apply them.";

const EMPTY_SCHEMA_PLACEHOLDER_NAME = "_placeholder";
const EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION = "Placeholder. Always pass true.";

/**
 * Clean JSON schema to be compatible with Antigravity
 */
function cleanJSONSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  
  if (Array.isArray(schema)) {
    return schema.map(cleanJSONSchema);
  }
  
  const cleaned = { ...schema };
  
  // Remove forbidden fields that Antigravity doesn't support
  const forbidden = [
    '$schema', '$id', 'default', 'examples', 'title',
    'exclusiveMinimum', 'exclusiveMaximum', 'minimum', 'maximum',
    'minLength', 'maxLength', 'minItems', 'maxItems',
    'pattern', 'format', 'additionalProperties', 'patternProperties',
    'propertyNames',
    'minProperties', 'maxProperties', 'uniqueItems', 'contentEncoding',
    'contentMediaType', 'if', 'then', 'else', 'allOf', 'oneOf', 'not'
  ];
  forbidden.forEach(f => delete cleaned[f]);
  
  // Convert const to enum
  if (cleaned.const !== undefined) {
    cleaned.enum = [cleaned.const];
    delete cleaned.const;
  }
  
  // Inline $defs/$ref (simplified: just remove them for now as complex resolution is hard in single file without library)
  // Ideally we would resolve them, but often LLMs provide self-contained schemas. 
  // If strict ref resolution is needed, we'd need a fuller implementation.
  delete cleaned.$defs;
  delete cleaned.definitions;
  delete cleaned.$ref;

  // Recursively clean properties (each property value is a schema)
  if (cleaned.properties && typeof cleaned.properties === 'object') {
    const newProps = {};
    for (const [key, value] of Object.entries(cleaned.properties)) {
      newProps[key] = cleanJSONSchema(value);
    }
    cleaned.properties = newProps;
  }
  if (cleaned.items) {
    cleaned.items = cleanJSONSchema(cleaned.items);
  }
  // Clean anyOf items
  if (Array.isArray(cleaned.anyOf)) {
    cleaned.anyOf = cleaned.anyOf.map(item => cleanJSONSchema(item));
  }
  
  // Fix type array -> anyOf (Antigravity doesn't support type: ["string", "null"])
  if (Array.isArray(cleaned.type)) {
     // Check for nullable
     if (cleaned.type.includes('null') && cleaned.type.length === 2) {
       cleaned.type = cleaned.type.find(t => t !== 'null');
       cleaned.nullable = true;
     } else {
       // fallback to first type if complex
       cleaned.type = cleaned.type[0];
     }
  }

  return cleaned;
}

function normalizeTools(tools, isClaude) {
  if (!tools || !Array.isArray(tools)) return undefined;

  const normalized = [];

  for (const tool of tools) {
    // Check for functionDeclarations (Anthropic style in Vertex)
    if (tool.functionDeclarations) {
       normalized.push(...tool.functionDeclarations.map(t => normalizeSingleTool(t, isClaude)));
       continue;
    }
    
    // Check for function/custom/params style
    const t = tool.function || tool.custom || tool;
    normalized.push(normalizeSingleTool(t, isClaude));
  }
  
  // Wrap based on provider expectations if needed, but Antigravity generally takes tools: [{ functionDeclarations: [...] }] structure
  // or a flat list if the API expects it. The Antigravity spec says:
  // "tools": [{ "functionDeclarations": [ ... ] }]
  
  return [{ functionDeclarations: normalized }];
}

function normalizeSingleTool(tool, isClaude) {
    let schema = tool.parameters || tool.input_schema || tool.inputSchema || (tool.function && tool.function.parameters);
    
    // Normalize schema
    if (!schema || Object.keys(schema).length === 0) {
        // Placeholder for empty schema
        schema = {
            type: "object",
            properties: {
                [EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
                    type: "boolean",
                    description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION
                }
            },
            required: [EMPTY_SCHEMA_PLACEHOLDER_NAME]
        };
    } else {
        schema = cleanJSONSchema(schema);
        
        // Claude VALIDATED mode requirement: must have properties
        if (isClaude && (!schema.properties || Object.keys(schema.properties).length === 0)) {
            schema.properties = {
                [EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
                    type: "boolean",
                    description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION
                }
            };
            schema.required = [EMPTY_SCHEMA_PLACEHOLDER_NAME];
        }
    }

    let name = tool.name || (tool.function && tool.function.name) || "unknown_tool";
    // Sanitize name
    name = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

    return {
        name: name,
        description: tool.description || "",
        parameters: schema
    };
}

// --- Main Class ---

class AntigravityTransformer {
  name = "antigravity";

  constructor(config) {
    this.config = config || {};
    this.lastSessionKey = null; // Track session key for signature caching
  }

  async getCredentials(modelName) {
    // Load accounts from opencode-antigravity-auth's accounts file
    const accountsData = loadAntigravityAccounts();
    if (!accountsData) {
      console.error("\n[Antigravity] No accounts file found at " + ANTIGRAVITY_ACCOUNTS_FILE);
      console.error("[Antigravity] Please run 'opencode auth login' to authenticate.\n");
      throw new Error("Antigravity credentials missing. Run 'opencode auth login' to authenticate.");
    }

    // Get the active account for this model family
    const modelFamily = getModelFamily(modelName);
    const account = getActiveAccount(accountsData, modelFamily);
    if (!account) {
      console.error("\n[Antigravity] No active account found in accounts file.\n");
      throw new Error("No active Antigravity account. Run 'opencode auth login' to add an account.");
    }

    // Extract refresh token and project ID from account
    // The account format stores projectId and managedProjectId
    const refreshToken = account.refreshToken;
    const projectId = account.managedProjectId || account.projectId;

    if (!refreshToken) {
      console.error("\n[Antigravity] Active account has no refresh token.\n");
      throw new Error("Antigravity account missing refresh token. Run 'opencode auth login' to re-authenticate.");
    }

    // Get or refresh access token
    // For now, we'll always refresh since we don't store access tokens
    // In production, you'd cache the access token with its expiry
    try {
      const tokenData = await refreshAccessToken(refreshToken);
      return {
        access_token: tokenData.access_token,
        expiry_date: tokenData.expiry_date,
        project_id: projectId || "rising-fact-p41fc", // fallback default
        refresh_token: refreshToken
      };
    } catch (e) {
      console.error("[Antigravity] Token refresh failed:", e.message);
      throw new Error("Antigravity token refresh failed. Please run 'opencode auth login' to re-authenticate.");
    }
  }

  async transformRequestIn(request, provider) {
    const creds = await this.getCredentials(request.model);

    const isClaude = request.model.toLowerCase().includes('claude');
    const isGemini = request.model.toLowerCase().includes('gemini');
    const isThinking = request.model.toLowerCase().includes('thinking') || (request.reasoning && request.reasoning.effort !== 'none');

    // 1. Construct Body
    const body = {
      project: creds.project_id,
      model: request.model, // e.g. "claude-sonnet-4-5" or "antigravity-claude..." (need to strip prefix?)
      // Note: Antigravity spec says "model": "{model_id}". 
      // If user passes "google/antigravity-claude-sonnet-4-5", we need to extract the ID.
      // Usually CCR passes the model name defined in config, or what the user typed.
      // Let's assume config maps "antigravity-claude-sonnet-4-5" -> "claude-sonnet-4-5" if needed,
      // or we handle stripping here. 
      // The spec lists IDs like `claude-sonnet-4-5`, `gemini-3-pro-high`.
      // If the CCR model is "antigravity-claude-sonnet-4-5", we should probably strip "antigravity-".
      request: {
        contents: [],
        generationConfig: {},
        tools: []
      },
      userAgent: "antigravity-ccr-plugin",
      requestId: `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    // Strip prefix if present
    if (body.model.startsWith('antigravity-')) {
        body.model = body.model.replace('antigravity-', '');
    }
    // Also strip "google/" if passed by CCR (it often passes "provider/model")
    if (body.model.includes('/')) {
        body.model = body.model.split('/').pop();
    }

    // Extract and strip thinking tier suffix (-low, -medium, -high) for thinking budget
    const tierMatch = body.model.match(/-(minimal|low|medium|high)$/);
    const thinkingTier = tierMatch ? tierMatch[1] : null;
    if (thinkingTier && body.model.includes('thinking')) {
        // For Claude thinking models, strip the tier suffix
        // e.g., claude-opus-4-5-thinking-low -> claude-opus-4-5-thinking
        body.model = body.model.replace(/-(minimal|low|medium|high)$/, '');
    }

    // Map thinking tier to budget
    const THINKING_TIER_BUDGETS = {
        minimal: 1024,
        low: 8192,
        medium: 16384,
        high: 32768,
    };
    
    // 2. Transform Messages -> Contents
    // Antigravity expects "role": "user" | "model"
    const contents = [];
    let systemInstruction = null;

    if (request.messages) {
      for (const msg of request.messages) {
        if (msg.role === 'system') {
          // Accumulate system instructions
          const text = typeof msg.content === 'string' ? msg.content : msg.content.map(p => p.text).join('\n');
          if (systemInstruction) {
             systemInstruction.parts[0].text += "\n\n" + text;
          } else {
             systemInstruction = { parts: [{ text }] };
          }
          continue;
        }

        const role = msg.role === 'assistant' ? 'model' : 'user';
        const parts = [];

        if (typeof msg.content === 'string') {
          parts.push({ text: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
             if (part.type === 'text') {
               parts.push({ text: part.text });
             } else if (part.type === 'image_url') {
               // Handle images - Antigravity likely expects inlineData or fileData
               // CCR usually provides base64 in url if it's data:image...
               if (part.image_url.url.startsWith('data:')) {
                 const [mime, data] = part.image_url.url.split(';base64,');
                 parts.push({
                   inlineData: {
                     mime_type: mime.replace('data:', ''),
                     data: data
                   }
                 });
               } else {
                 parts.push({ text: `[Image: ${part.image_url.url}]` });
               }
             }
          }
        }
        
        // Handle tool calls in assistant message
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            parts.push({
              functionCall: {
                name: tc.function.name,
                args: JSON.parse(tc.function.arguments),
                id: tc.id // Include ID for tracking
              }
            });
          }
        }
        
        // Handle tool responses in user message (role=tool in CCR)
        // CCR sends role='tool', but Antigravity expects role='user' (or 'function' depending on spec, but usually part of user turn)
        // Wait, Antigravity spec says: 
        // { "role": "user", "parts": [{ "functionResponse": { ... } }] }
        // We need to handle this.
        
        contents.push({ role, parts });
      }
    }
    
    // Handle separate tool messages (CCR sends them as separate messages with role='tool')
    // We need to merge them into the previous user turn or create a new user turn?
    // Actually, typical chat format is User -> Model -> User (with tool results).
    // So if we see role='tool', it should be converted to a user message with functionResponse parts.
    
    // Post-process contents to merge/fix tool roles
    const finalContents = [];

    // Debug log the incoming messages structure
    if (DEBUG) {
       log('debug', 'Processing messages', {
          count: request.messages?.length || 0,
          roles: request.messages?.map(m => m.role) || [],
          contentTypes: request.messages?.map(m => {
             if (typeof m.content === 'string') return 'string';
             if (Array.isArray(m.content)) return m.content.map(c => c.type || 'unknown');
             return typeof m.content;
          }) || []
       });
    }

    for (const msg of request.messages) {
       if (msg.role === 'tool') {
          // This is a function response
          const responsePart = {
             functionResponse: {
                name: msg.name, // CCR might not pass name here directly, often in tool_call_id linkage. 
                // We might need to look up name if not provided. 
                // Assuming msg.name exists or we need to rely on tool_call_id.
                // Spec says: { "name": "get_weather", "response": { ... }, "id": "..." }
                response: { result: msg.content },
                id: msg.tool_call_id
             }
          };
          
          // Add to last user message if possible, or create new
          const last = finalContents[finalContents.length - 1];
          if (last && last.role === 'user') {
             last.parts.push(responsePart);
          } else {
             finalContents.push({ role: 'user', parts: [responsePart] });
          }
       } else if (msg.role !== 'system') {
          // Re-map the parts generated above
           const role = msg.role === 'assistant' ? 'model' : 'user';
           const parts = [];

           if (typeof msg.content === 'string') {
              parts.push({ text: msg.content });
           } else if (Array.isArray(msg.content)) {
               msg.content.forEach(c => {
                   if (c.type === 'text') {
                      // Ensure text is a string, not nested
                      const textValue = typeof c.text === 'string' ? c.text :
                                       (c.text?.text || JSON.stringify(c.text) || '');
                      if (textValue) parts.push({ text: textValue });
                   } else if (c.type === 'thinking' || c.type === 'redacted_thinking') {
                      // Handle thinking blocks from previous turns
                      const thinkingText = c.thinking || c.text || '(thinking)';
                      parts.push({
                         thought: true,
                         text: typeof thinkingText === 'string' ? thinkingText : '(thinking)',
                         ...(c.signature && { thoughtSignature: c.signature })
                      });
                   } else if (c.type === 'tool_use') {
                      // Handle tool_use blocks (Anthropic format)
                      parts.push({
                         functionCall: {
                            name: c.name,
                            args: c.input || {},
                            id: c.id
                         }
                      });
                   } else if (c.type === 'tool_result') {
                      // Handle tool_result blocks (Anthropic format)
                      parts.push({
                         functionResponse: {
                            name: c.name || 'unknown',
                            response: { result: typeof c.content === 'string' ? c.content : JSON.stringify(c.content) },
                            id: c.tool_use_id
                         }
                      });
                   } else if (c.type === 'image_url' || c.type === 'image') {
                      // Handle images
                      const imgUrl = c.image_url?.url || c.source?.data;
                      if (imgUrl?.startsWith('data:')) {
                         const [mime, data] = imgUrl.split(';base64,');
                         parts.push({
                            inlineData: {
                               mime_type: mime.replace('data:', ''),
                               data: data
                            }
                         });
                      }
                   }
               });
           } else if (msg.content && typeof msg.content === 'object') {
              // Handle object content (e.g., {text: "..."})
              const textValue = msg.content.text || JSON.stringify(msg.content);
              parts.push({ text: typeof textValue === 'string' ? textValue : String(textValue) });
           }

           // Handle tool_calls from OpenAI format
           if (msg.tool_calls) {
               msg.tool_calls.forEach(tc => {
                   parts.push({
                       functionCall: {
                           name: tc.function.name,
                           args: typeof tc.function.arguments === 'string'
                                 ? JSON.parse(tc.function.arguments || "{}")
                                 : (tc.function.arguments || {}),
                           id: tc.id
                       }
                   });
               });
           }

           // Handle thinking from message (CCR format)
           if (msg.thinking?.signature && role === 'model') {
              // Prepend thinking block if we have a signature
              parts.unshift({
                 thought: true,
                 text: msg.thinking.content || '(thinking)',
                 thoughtSignature: msg.thinking.signature
              });
           }

           // Only add if we have parts
           if (parts.length > 0) {
              finalContents.push({ role, parts });
           }
       }
    }
    
    // Generate session key for signature caching
    const sessionKey = `${creds.project_id}:${body.model}`;
    this.lastSessionKey = sessionKey; // Store for use in transformResponseOut
    log('debug', 'Processing request', { model: body.model, sessionKey, messageCount: finalContents.length });

    // For Claude thinking models with tool use, inject thinking blocks
    if (isClaude && isThinking) {
       const cachedSig = getCachedSignature(sessionKey);

       // Check if there are tool calls in any model message
       const hasToolCalls = finalContents.some(c =>
          c.role === 'model' && c.parts?.some(p => p.functionCall)
       );

       if (hasToolCalls && cachedSig) {
          log('debug', 'Injecting thinking blocks for tool calls', { hasSignature: !!cachedSig.signature });

          // Inject thinking block at the start of each model message that has tool calls
          finalContents.forEach(content => {
             if (content.role === 'model') {
                const hasToolCall = content.parts?.some(p => p.functionCall);
                const hasThinking = content.parts?.some(p => p.thought === true);

                if (hasToolCall && !hasThinking) {
                   // Insert thinking block at the beginning
                   content.parts.unshift({
                      thought: true,
                      text: cachedSig.text || "(thinking)",
                      thoughtSignature: cachedSig.signature
                   });
                   log('debug', 'Injected thinking block into model message');
                }
             }
          });
       }

       // Also handle thinking blocks from CCR format (msg.thinking property)
       finalContents.forEach(content => {
          if (content.role === 'model' && content.parts) {
             // Check if original message had thinking
             const originalMsg = request.messages?.find(m =>
                m.role === 'assistant' && m.thinking?.signature
             );
             if (originalMsg?.thinking) {
                const hasThinking = content.parts.some(p => p.thought === true);
                if (!hasThinking) {
                   content.parts.unshift({
                      thought: true,
                      text: originalMsg.thinking.content || "(thinking)",
                      thoughtSignature: originalMsg.thinking.signature
                   });
                   // Also cache this signature for future use
                   cacheSignature(sessionKey, originalMsg.thinking.content, originalMsg.thinking.signature);
                }
             }
          }
       });
    }

    body.request.contents = finalContents;

    // 3. System Instructions
    if (systemInstruction) {
       body.request.systemInstruction = systemInstruction;
    }
    
    // 4. Tools
    if (request.tools && request.tools.length > 0) {
       body.request.tools = normalizeTools(request.tools, isClaude);
    }

    // 5. Generation Config & Thinking
    const genConfig = {
       maxOutputTokens: request.max_tokens || 8192,
       temperature: request.temperature,
    };

    if (isThinking) {
       // Append hint for Claude
       if (isClaude && body.request.systemInstruction) {
          const hint = CLAUDE_INTERLEAVED_THINKING_HINT;
          body.request.systemInstruction.parts[0].text += "\n\n" + hint;
       } else if (isClaude) {
          body.request.systemInstruction = { parts: [{ text: CLAUDE_INTERLEAVED_THINKING_HINT }] };
       }

       // Config
       // For Gemini 3: thinkingLevel ("high", "low")
       // For Claude: thinking_budget (snake_case)
       const budget = thinkingTier ? THINKING_TIER_BUDGETS[thinkingTier] : (request.reasoning?.max_tokens || 8192);

       if (isClaude) {
           genConfig.thinkingConfig = {
               include_thoughts: true,
               thinking_budget: budget
           };
           // Ensure max tokens > budget
           if (genConfig.maxOutputTokens <= budget) {
               genConfig.maxOutputTokens = Math.max(64000, budget + 2000);
           }
       } else if (isGemini) {
           // Gemini 3 vs 2.5 check
           if (body.model.includes('gemini-3')) {
               genConfig.thinkingConfig = {
                   includeThoughts: true,
                   thinkingLevel: "HIGH" // Default to HIGH or infer from budget?
               };
           } else {
               genConfig.thinkingConfig = {
                   includeThoughts: true,
                   thinkingBudget: budget
               };
           }
       }
    }
    
    // Claude Validated Mode
    if (isClaude && request.tools && request.tools.length > 0) {
       // Inject into body at root or generation config?
       // Antigravity spec says `toolConfig` at root of request object inside `request`
       if (!body.request.toolConfig) body.request.toolConfig = {};
       body.request.toolConfig.functionCallingConfig = { mode: "VALIDATED" };
    }

    body.request.generationConfig = genConfig;

    // 6. Return CCR structure
    return {
       body: body,
       config: {
           url: new URL(`${ENDPOINTS[0]}/v1internal:${request.stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`),
           headers: {
               Authorization: `Bearer ${creds.access_token}`,
               ...ANTIGRAVITY_HEADERS
           }
       }
    };
  }

  async transformResponseOut(response) {
     // Check if streaming
     const contentType = response.headers.get('content-type') || '';
     if (contentType.includes('text/event-stream')) {
        return this.handleStream(response);
     }

     // Handle JSON
     const data = await response.json();

     // Convert Antigravity response to OpenAI format
     // Antigravity: { response: { candidates: [ ... ] } }
     // OpenAI: { choices: [ ... ] }

     const candidate = data.response?.candidates?.[0];
     if (!candidate) {
        return new Response(JSON.stringify({ error: "No candidates returned" }), {
           status: response.status,
           statusText: response.statusText,
           headers: response.headers,
        });
     }

     const message = {
        role: "assistant",
        content: null,
        tool_calls: []
     };

     // Parts - separate thinking parts from non-thinking
     const parts = candidate.content?.parts || [];
     let textContent = "";
     let thinkingContent = "";
     let thinkingSignature = "";

     parts.forEach(p => {
        if (p.text && p.thought === true) {
           thinkingContent += p.text;
        } else if (p.text) {
           textContent += p.text;
        }
        if (p.thoughtSignature) {
           thinkingSignature = p.thoughtSignature;
        }
        if (p.functionCall) {
           message.tool_calls.push({
              id: p.functionCall.id || `call_${Math.random().toString(36).substr(2,9)}`,
              type: 'function',
              function: {
                 name: p.functionCall.name,
                 arguments: JSON.stringify(p.functionCall.args)
              }
           });
        }
     });

     if (textContent) message.content = textContent;
     if (message.tool_calls.length === 0) delete message.tool_calls;

     // Add thinking block if present
     if (thinkingSignature) {
        message.thinking = {
           content: thinkingContent || "(no content)",
           signature: thinkingSignature,
        };

        // Cache the signature for future multi-turn requests
        if (this.lastSessionKey) {
           cacheSignature(this.lastSessionKey, thinkingContent || "(no content)", thinkingSignature);
           log('debug', 'Cached thinking signature from response', { sessionKey: this.lastSessionKey });
        }
     }

     log('debug', 'Response processed', {
        hasThinking: !!thinkingSignature,
        hasToolCalls: message.tool_calls?.length > 0,
        contentLength: textContent?.length || 0
     });

     const result = {
        id: data.response?.responseId || `resp_${Date.now()}`,
        choices: [{
           message,
           finish_reason: candidate.finishReason === "STOP" ? "stop" :
                         candidate.finishReason === "MAX_TOKENS" ? "length" :
                         (candidate.finishReason?.toLowerCase() || "stop"),
           index: 0,
        }],
        created: Math.floor(Date.now() / 1000),
        model: data.response?.modelVersion || "unknown",
        object: "chat.completion",
        usage: {
           prompt_tokens: data.response?.usageMetadata?.promptTokenCount || 0,
           completion_tokens: data.response?.usageMetadata?.candidatesTokenCount || 0,
           total_tokens: data.response?.usageMetadata?.totalTokenCount || 0,
           thoughts_token_count: data.response?.usageMetadata?.thoughtsTokenCount,
        }
     };

     return new Response(JSON.stringify(result), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
     });
  }
  
  handleStream(response) {
      // Need to return a response that is an SSE stream converted to OpenAI format
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const sessionKey = this.lastSessionKey;
      let accumulatedThinking = '';
      let lastSignature = null;

      const transformStream = new TransformStream({
          async transform(chunk, controller) {
              const text = decoder.decode(chunk);
              const lines = text.split('\n');
              for (const line of lines) {
                  if (line.startsWith('data: ')) {
                      try {
                          const json = JSON.parse(line.slice(6));
                          const candidate = json.response?.candidates?.[0];
                          if (!candidate) continue;

                          // Handle content parts
                          if (candidate.content?.parts) {
                              for (const part of candidate.content.parts) {
                                  // Cache signature when we see it
                                  if (part.thoughtSignature) {
                                      lastSignature = part.thoughtSignature;
                                      log('debug', 'Found signature in stream chunk');
                                  }

                                  if (part.text && part.thought === true) {
                                      // Thinking content - accumulate and send as thinking delta
                                      accumulatedThinking += part.text;
                                      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                                          choices: [{
                                              index: 0,
                                              delta: {
                                                  role: "assistant",
                                                  thinking: { content: part.text }
                                              }
                                          }]
                                      })}\n\n`));
                                  } else if (part.text) {
                                      // Regular text content
                                      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                                          choices: [{
                                              index: 0,
                                              delta: { role: "assistant", content: part.text }
                                          }]
                                      })}\n\n`));
                                  }

                                  if (part.functionCall) {
                                      const toolCall = {
                                          index: 0,
                                          id: part.functionCall.id || `call_${Math.random().toString(36).substr(2,9)}`,
                                          type: 'function',
                                          function: {
                                              name: part.functionCall.name,
                                              arguments: JSON.stringify(part.functionCall.args || {})
                                          }
                                      };
                                      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                                          choices: [{ index: 0, delta: { tool_calls: [toolCall] } }]
                                      })}\n\n`));
                                  }
                              }
                          }
                      } catch (e) {
                          log('debug', 'Stream parse error', { error: e.message });
                      }
                  }
              }
          },
          flush(controller) {
              // At end of stream, cache the signature if we found one
              if (lastSignature && sessionKey) {
                  cacheSignature(sessionKey, accumulatedThinking || "(no content)", lastSignature);
                  log('debug', 'Cached signature from stream', { sessionKey });

                  // Also send the signature in the final thinking chunk
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                      choices: [{
                          index: 0,
                          delta: {
                              thinking: { signature: lastSignature }
                          }
                      }]
                  })}\n\n`));
              }
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          }
      });

      return new Response(response.body.pipeThrough(transformStream), {
          headers: { 'Content-Type': 'text/event-stream' }
      });
  }
}

// CLI Entry Point
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args[0] === 'login') {
    performLogin().catch(console.error);
  } else if (args[0] === 'status') {
    const accountsData = loadAntigravityAccounts();
    if (!accountsData) {
      console.log("No accounts found. Run 'node plugins/antigravity.js login' to add an account.");
    } else {
      console.log(`Accounts file: ${ANTIGRAVITY_ACCOUNTS_FILE}`);
      console.log(`Total accounts: ${accountsData.accounts.length}`);
      console.log(`Active index: ${accountsData.activeIndex}`);
      console.log(`Active by family:`, accountsData.activeIndexByFamily);
      console.log("\nAccounts:");
      accountsData.accounts.forEach((acc, i) => {
        const active = i === accountsData.activeIndex ? ' [ACTIVE]' : '';
        console.log(`  ${i}. ${acc.email || 'unknown'}${active}`);
        console.log(`     Project: ${acc.managedProjectId || acc.projectId || 'unknown'}`);
      });
    }
  } else {
    console.log("Antigravity plugin for CCR");
    console.log("");
    console.log("Commands:");
    console.log("  node plugins/antigravity.js login    - Add a new account via OAuth");
    console.log("  node plugins/antigravity.js status   - Show current accounts");
    console.log("");
    console.log("Accounts file: " + ANTIGRAVITY_ACCOUNTS_FILE);
  }
}

module.exports = AntigravityTransformer;
