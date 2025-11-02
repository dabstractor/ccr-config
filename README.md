# CCR GLM Config

A **Claude Code Router** configuration for integrating **Z.AI GLM models** with intelligent routing and vision processing capabilities.

## Overview

This configuration enables Claude Code Router to automatically route requests to different Z.AI GLM models based on task type and context, with advanced image analysis capabilities through a custom vision transformer plugin.

## Features

- **Intelligent Model Routing**: Automatically selects the best GLM model for different tasks
- **Vision Processing**: Analyzes images and screenshots with GLM-4.5-v
- **Multi-Model Support**: GLM-4.6, GLM-4.5, and GLM-4.5-air models
- **Context Awareness**: Handles both short and long conversations efficiently
- **OpenAI Compatibility**: Works with tools expecting OpenAI API format

## Prerequisites

### 1. Install Claude Code Router

```bash
# Clone the Claude Code Router repository
git clone https://github.com/dustinvsmith/claude-code-router.git
cd claude-code-router

# Install dependencies
npm install

# Install globally
npm install -g .
```

### 2. Get Z.AI API Key

1. Sign up at [Z.AI](https://z.ai)
2. Generate an API key from your account settings
3. Set the environment variable:

```bash
export Z_AI_API_KEY="your_api_key_here"
```

## Quick Start

1. **Clone this configuration:**
   ```bash
   git clone <this-repository-url>
   cd ccr-glm-config
   ```

2. **Set up your Z.AI API key:**
   ```bash
   export Z_AI_API_KEY="your_api_key_here"
   ```

3. **Start the router:**
   ```bash
   ccr start
   ```

4. **Configure Claude Code to use the router:**
   ```bash
   claude code config set api_base_url http://localhost:3000/v1
   ```

## Configuration

### Model Routing

The router automatically selects models based on task type:

| Task Type | Model | Use Case |
|-----------|-------|----------|
| `default` | GLM-4.6 | General conversations |
| `background` | GLM-4.5-air | Lightweight background tasks |
| `think` | GLM-4.6 | Complex reasoning |
| `longContext` | GLM-4.6 | Large contexts (>200k tokens) |
| `webSearch` | GLM-4.5-air | Web search queries |
| `coding` | GLM-4.6 | Programming tasks |

### Vision Capabilities

The included vision transformer automatically:
- Analyzes images in your messages
- Extracts text from screenshots
- Describes visual content
- Integrates analysis into conversation context

**Limits:**
- Max image size: 5MB
- Timeout: 60 seconds per analysis

## File Structure

```
ccr-glm-config/
├── config.json              # Main router configuration
├── plugins/
│   └── z-ai-vision.js      # Vision transformer plugin
├── logs/                    # Runtime logs
└── README.md               # This file
```

## Configuration File

The main `config.json` contains:

- **Provider settings** for Z.AI GLM models
- **Routing rules** for different task types
- **Transformer pipeline** including vision processing
- **API timeouts** and logging preferences

## Usage Examples

### Basic Conversation

```bash
# Start a conversation
claude code "Explain quantum computing"
# Routes to: GLM-4.6
```

### Image Analysis

```bash
# Send an image
claude code --image screenshot.png "What does this error mean?"
# Routes to: GLM-4.6 + Vision Transformer
```

### Coding Task

```bash
# Code generation
claude code "Write a Python function to sort a list"
# Routes to: GLM-4.6 (coding context)
```

### Background Task

```bash
# Simple query
claude code "What's the weather like?"
# Routes to: GLM-4.5-air (efficient for simple tasks)
```

## Troubleshooting

### Common Issues

1. **"API key not found"**
   - Make sure `Z_AI_API_KEY` environment variable is set
   - Verify your Z.AI account has active API access

2. **"Vision analysis failed"**
   - Check image size is under 5MB
   - Ensure image format is supported (PNG, JPG, WebP)
   - Verify internet connectivity for vision API

3. **"Router not responding"**
   - Check if Claude Code Router is installed and running
   - Verify the router is listening on port 3000
   - Check logs in `logs/` directory

### Viewing Logs

```bash
# View latest log
tail -f logs/ccr-console.log

# View session logs
ls logs/ccr-*.log
```

## Customization

### Adding Custom Routing

Create a custom router function in your config:

```javascript
{
  "router": {
    "type": "custom",
    "path": "./custom-router.js"
  }
}
```

### Modifying Model Selection

Edit `config.json` to change model assignments:

```json
{
  "router": {
    "rules": {
      "coding": "z-ai,GLM-4.5"  // Use GLM-4.5 for coding instead
    }
  }
}
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

- **Claude Code Router**: [GitHub Repository](https://github.com/dustinvsmith/claude-code-router)
- **Z.AI Documentation**: [Z.AI Developer Portal](https://z.ai/docs)
- **Issues**: Report bugs via GitHub Issues

---

**Note**: This configuration requires an active Z.AI API subscription. Check Z.AI pricing for usage costs.