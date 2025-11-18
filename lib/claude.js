import Anthropic from '@anthropic-ai/sdk';

const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  console.error('❌ Anthropic API key missing!');
  throw new Error('Claude API configuration error');
}

export const anthropic = new Anthropic({
  apiKey: apiKey,
});

console.log('✅ Claude client initialized');
