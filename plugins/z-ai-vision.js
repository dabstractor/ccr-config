class ZAiVisionTransformer {
  constructor(options = {}) {
    this.name = 'z-ai-vision';
    this.options = options;
    this.apiReady = false;
    this.apiKey = null;
    this.apiUrl = null;
    this.initApi();
  }

  initApi() {
    console.log('[Z-AI-VISION] Initializing Z-AI API...');

    // Check environment variable
    this.apiKey = process.env.Z_AI_API_KEY;
    if (!this.apiKey || this.apiKey.includes('your-') || this.apiKey.includes('placeholder') || this.apiKey === '') {
      console.error('[Z-AI-VISION] ERROR: Z_AI_API_KEY not set or placeholder detected');
      this.apiReady = false;
      return;
    }

    // Set API URL (Z-AI platform)
    this.apiUrl = 'https://api.z.ai/api/paas/v4/chat/completions';
    this.apiReady = true;
    console.log('[Z-AI-VISION] Z-AI API initialized successfully');
  }

  /**
   * Check if a message contains image content (supports both Anthropic and OpenAI formats)
   */
  hasImages(message) {
    if (!Array.isArray(message.content)) {
      return false;
    }

    return message.content.some(content => {
      // Anthropic format: {type: "image", source: {...}}
      if (content.type === 'image' && content.source) {
        return true;
      }
      // OpenAI format: {type: "image_url", image_url: {...}}
      if (content.type === 'image_url' && content.image_url) {
        return true;
      }
      return false;
    });
  }

  /**
   * Extract image data from message content (supports both Anthropic and OpenAI formats)
   */
  extractImages(message) {
    if (!Array.isArray(message.content)) {
      return [];
    }

    const images = [];
    for (const content of message.content) {
      let dataUrl = null;
      let mediaType = null;
      let base64Data = null;

      // Handle Anthropic format
      if (content.type === 'image' && content.source && content.source.type === 'base64') {
        const { source } = content;
        if (!source.data) {
          console.warn('[Z-AI-VISION] Anthropic format image missing data, skipping');
          continue;
        }
        base64Data = source.data;
        mediaType = source.media_type;
        dataUrl = `data:${mediaType};base64,${base64Data}`;
      }
      // Handle OpenAI format
      else if (content.type === 'image_url' && content.image_url && content.image_url.url) {
        dataUrl = content.image_url.url;
        
        const mediaTypeMatch = dataUrl.match(/^data:(image\/[^;]+);base64,/);
        if (mediaTypeMatch) {
          mediaType = content.media_type || mediaTypeMatch[1];
        } else {
          console.warn('[Z-AI-VISION] OpenAI format image URL not in expected format, skipping');
          continue;
        }
        
        base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
      } else {
        continue;
      }

      // Check size limit (5MB)
      const sizeInMB = (base64Data.length * 0.75) / 1024 / 1024;
      if (sizeInMB > 5) {
        console.warn(`[Z-AI-VISION] Image too large: ${sizeInMB.toFixed(2)}MB, skipping`);
        continue;
      }

      images.push({
        dataUrl,
        mediaType,
        sizeInMB
      });
    }

    return images;
  }

  /**
   * Analyze image using Z-AI vision API
   */
  async analyzeImage(imageDataUrl) {
    if (!this.apiReady || !this.apiKey) {
      throw new Error('Z-AI API not ready');
    }

    try {
      console.log('[Z-AI-VISION] Calling Z-AI vision API...');

      const requestBody = {
        model: 'glm-4.5v',
        messages: [{
          role: 'user',
          content: [
            { 
              type: 'image_url', 
              image_url: { url: imageDataUrl } 
            },
            { 
              type: 'text', 
              text: 'Provide a detailed description of this image, including all visible text, UI elements, code, diagrams, and other relevant details.' 
            }
          ]
        }],
        thinking: { type: 'enabled' },
        stream: false,
        temperature: 0.8,
        top_p: 0.6,
        max_tokens: 16384
      };

      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': '4.5V MCP Local',
          'Accept-Language': 'en-US,en'
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(60000) // 60 second timeout
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const result = await response.json();
      const analysisText = result.choices?.[0]?.message?.content;

      if (!analysisText || analysisText.trim() === '') {
        throw new Error('Empty response from vision API');
      }

      console.log('[Z-AI-VISION] Image analysis complete');
      return analysisText;

    } catch (error) {
      console.error('[Z-AI-VISION] Image analysis failed:', error.message);
      throw error;
    }
  }

  /**
   * Build new content array with vision analysis injected (filters both formats)
   */
  buildNewContent(originalContent, visionAnalyses) {
    // Filter out image content (both Anthropic and OpenAI formats)
    const nonImageContent = originalContent.filter(content => 
      content.type !== 'image' && content.type !== 'image_url'
    );

    if (visionAnalyses.length === 0) {
      return nonImageContent;
    }

    // Build vision analysis text
    const visionText = visionAnalyses.map((analysis, idx) =>
      `\n\n[Vision Analysis ${idx + 1}]: ${analysis}`
    ).join('');

    // Add vision analysis to first text block, or create new one
    const textBlock = nonImageContent.find(c => c.type === 'text');
    if (textBlock) {
      textBlock.text += visionText;
    } else {
      nonImageContent.unshift({
        type: 'text',
        text: visionText.trim()
      });
    }

    return nonImageContent;
  }

  async transformRequestIn(request, model) {
    console.log('[Z-AI-VISION] transformRequestIn called');

    if (!this.apiReady) {
      console.log('[Z-AI-VISION] API not ready, skipping vision processing');
      return request;
    }

    // Deep clone to avoid mutations
    const modifiedRequest = JSON.parse(JSON.stringify(request));

    try {
      // Process each message
      for (let i = 0; i < modifiedRequest.messages.length; i++) {
        const message = modifiedRequest.messages[i];

        if (!this.hasImages(message)) {
          continue;
        }

        console.log(`[Z-AI-VISION] Processing message ${i + 1} with images`);

        const images = this.extractImages(message);
        if (images.length === 0) {
          console.log('[Z-AI-VISION] No valid images found after extraction');
          continue;
        }

        // Analyze each image
        const analyses = [];
        for (const img of images) {
          try {
            console.log(`[Z-AI-VISION] Analyzing image (${img.mediaType}, ${img.sizeInMB.toFixed(2)}MB)`);
            const analysis = await this.analyzeImage(img.dataUrl);
            analyses.push(analysis);
          } catch (error) {
            console.error('[Z-AI-VISION] Failed to analyze image:', error.message);
            analyses.push('[Image analysis failed]');
          }
        }

        // Build new content without images, but with vision analysis
        modifiedRequest.messages[i].content = this.buildNewContent(message.content, analyses);

        console.log(`[Z-AI-VISION] Message ${i + 1} processed: ${images.length} images analyzed`);
      }

      return modifiedRequest;
    } catch (error) {
      console.error('[Z-AI-VISION] Error in transformRequestIn:', error);
      return request; // Return original on error
    }
  }

  async transformResponseOut(response) {
    // No response transformation needed for vision
    return response;
  }
}

module.exports = ZAiVisionTransformer;
