# CCR GLM Config

A ready-to-use configuration that adds **GLM model support to Claude Code Router** for **Thinking**, **WebSearch**, and **Image Uploads**.

## Quick Setup

### 1. Install Claude Code

```bash
# Install Claude Code CLI
npm install -g @anthropic/claude-code
```

### 2. Install Claude Code Router

```bash
# Clone the Claude Code Router repository
git clone https://github.com/dustinvsmith/claude-code-router.git
cd claude-code-router

# Install dependencies
npm install

# Install globally
npm install -g .
```

### 3. Get Z.AI API Key

1. Sign up at [Z.AI](https://z.ai)
2. Generate an API key from your account settings
3. Set the environment variable:

```bash
export Z_AI_API_KEY="your_api_key_here"
```

### 4. Install This Configuration

```bash
# Clone this configuration directly as your CCR config
git clone <this-repository-url> ~/.claude-code-router

# Navigate to the config directory
cd ~/.claude-code-router
```

### 5. Start Using Claude Code

```bash
# Run Claude Code
ccr code
```

That's it! Claude Code will now automatically use Z.AI GLM models with intelligent routing.

## What This Enables

This configuration adds these GLM capabilities to Claude Code:

- **🧠 Thinking**: Advanced reasoning and problem-solving with GLM's thinking models
- **🔍 WebSearch**: Real-time web search integration through GLM's search capabilities
- **🖼️ Image Uploads**: Visual analysis and image understanding with GLM's vision models

## Why This Matters

GLM's official interfaces only give you basic chat. This configuration unlocks the full power of your GLM plan by integrating Thinking, WebSearch, and Vision capabilities directly into your development workflow - the seamless experience you should have had out of the box.

## Example Usage

```bash
# Start Claude Code with GLM models
ccr code

# Example interactions within Claude Code:
# "Think through this step by step: [complex problem]"
# "Search the web for latest information about [topic]"
# "Analyze this image: [paste image directly]"
# "Write a Python function to sort a list"
```

## Troubleshooting

### Router won't start
```bash
# Check if CCR is installed
ccr --version
```

### API key issues
```bash
# Verify environment variable is set
echo $Z_AI_API_KEY

# Set it for the current session
export Z_AI_API_KEY="your_api_key_here"
```

### Can't connect to Claude Code
```bash
# Make sure router is running
ccr status

# Restart if needed
ccr restart
```

## Support

- **Claude Code Router**: [GitHub Repository](https://github.com/dustinvsmith/claude-code-router)
- **Z.AI Documentation**: [Z.AI Developer Portal](https://z.ai/docs)
