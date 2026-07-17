import { generateWithLlm } from './llmClient.js';
import { parseJson } from '../utils.js';

export async function draftAdCopy({ penName, book, platform, angle }) {
  const brand = parseJson(penName.brand_details, {});
  const system = `Draft ad copy for author ads. Do not claim awards, rankings, or reviews unless supplied.`;
  const prompt = `Pen name: ${penName.display_name}
Brand voice: ${brand.voice || 'commercial but on-brand'}
Genre: ${brand.genre || 'fiction'}
Book: ${book?.title || 'unspecified'}
Series: ${book?.series || 'standalone or unspecified'}
Platform: ${platform}
Creative angle: ${angle || 'hooky reader-facing ad'}

Return 5 headline/body/CTA options and 3 creative angle notes.`;
  return generateWithLlm({ system, prompt });
}
