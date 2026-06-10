import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// 本地展示用：可直接把 Gemini API key 寫在這裡
// 只適合本地 demo，不要把真正的 key 上傳到公開 GitHub。
// 用法：把 PASTE_YOUR_GEMINI_API_KEY_HERE 換成你的 key。
// ============================================================
const HARDCODED_GEMINI_API_KEY = 'PASTE_YOUR_GEMINI_API_KEY_HERE';

function getGeminiApiKey() {
  const hardcodedKey = HARDCODED_GEMINI_API_KEY.trim();
  if (hardcodedKey && hardcodedKey !== 'AIzaSyD1r1Amjs6I3NClptpGoYjg46BVQxXwPec') {
    return hardcodedKey;
  }
  return process.env.GEMINI_API_KEY || '';
}

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use(express.static(__dirname));

const QUESTION_TYPES = ['顏色', '物件', '數量', '位置', '動作', '細節', '其他'];

function validateQuestionData(data) {
  if (!data || typeof data !== 'object') return false;
  if (typeof data.question !== 'string' || data.question.trim().length === 0) return false;
  if (!Array.isArray(data.options) || data.options.length !== 3) return false;
  if (!data.options.every(opt => typeof opt === 'string' && opt.trim().length > 0)) return false;
  if (![0, 1, 2].includes(Number(data.correctIndex))) return false;
  if (typeof data.hint !== 'string' || data.hint.trim().length === 0) return false;
  if (typeof data.targetObject !== 'string' || data.targetObject.trim().length === 0) return false;
  if (typeof data.questionType !== 'string' || data.questionType.trim().length === 0) return false;

  const normalizedOptions = data.options.map(opt => String(opt).trim());
  const uniqueOptions = new Set(normalizedOptions);
  if (uniqueOptions.size !== 3) return false;

  return true;
}

function normalizeGeminiQuestion(data) {
  return {
    question: String(data.question).trim(),
    options: data.options.map(opt => String(opt).trim()).slice(0, 3),
    correctIndex: Number(data.correctIndex),
    hint: String(data.hint).trim(),
    targetObject: String(data.targetObject).trim(),
    questionType: String(data.questionType).trim()
  };
}

function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (_) {
      return null;
    }
  }
}

function resolveLocalImagePath(imagePath = '') {
  if (typeof imagePath !== 'string') return null;
  if (!imagePath.startsWith('Image/')) return null;

  const normalized = path.normalize(imagePath).replace(/^([.][.]([/\\]|$))+/, '');
  const absolutePath = path.join(__dirname, normalized);
  const imageRoot = path.join(__dirname, 'Image');

  if (!absolutePath.startsWith(imageRoot)) return null;
  if (!fs.existsSync(absolutePath)) return null;

  return absolutePath;
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function buildErrorResponse(reason, message) {
  return {
    success: false,
    source: 'none',
    reason,
    message,
    questionData: null
  };
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    server: 'running',
    geminiKeyConfigured: Boolean(getGeminiApiKey()),
    keySource: (HARDCODED_GEMINI_API_KEY.trim() && HARDCODED_GEMINI_API_KEY !== 'PASTE_YOUR_GEMINI_API_KEY_HERE') ? 'hardcoded' : (process.env.GEMINI_API_KEY ? 'env' : 'none'),
    model: GEMINI_MODEL,
    mode: 'ai-only-no-fallback'
  });
});

app.post('/api/generate-question', async (req, res) => {
  const {
    levelId,
    imagePath,
    randomSeed
  } = req.body || {};

  const geminiApiKey = getGeminiApiKey();
  if (!geminiApiKey) {
    console.warn('[Gemini] Gemini API key 未設定。AI-only 模式不會使用預設題目。');
    return res.status(200).json(buildErrorResponse(
      'missing_api_key',
      'Gemini API key 未設定。請在 server.js 的 HARDCODED_GEMINI_API_KEY 填入 key。'
    ));
  }

  const localImagePath = resolveLocalImagePath(imagePath);
  if (!localImagePath) {
    console.warn(`[Gemini] 找不到圖片或圖片路徑不合法：${imagePath}`);
    return res.status(200).json(buildErrorResponse(
      'image_not_found',
      `找不到圖片：${imagePath}`
    ));
  }

  try {
    const imageBuffer = fs.readFileSync(localImagePath);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = getMimeType(localImagePath);
    const ai = new GoogleGenAI({ apiKey: geminiApiKey });

    const systemInstruction = `你是高齡友善互動記憶遊戲的 AI 出題系統。玩家會先看一張窗外圖片 10 秒，之後圖片會被水滴遮住，玩家必須根據記憶回答問題。請你根據圖片內容，每次隨機產生一題新的觀察記憶題、三個選項、正確答案索引，以及一個提示。你可以自由選擇圖片中任何可見內容來提問，但問題必須能直接從圖片中回答，不可以編造圖片外的內容。`;

    const prompt = `關卡名稱：${levelId || '未命名關卡'}
隨機種子：${randomSeed || Date.now()}

請根據圖片隨機生成一題新的觀察記憶題。

出題規則：
1. 你可以自由提問圖片中任何看得見的內容，例如人物、物件、顏色、位置、動作、數量、背景細節。
2. 題目必須能直接從圖片回答，不要問圖片看不出來的事情。
3. 問題文字請自然、像孫子或孫女在問阿公阿嬤。
4. 問題不要超過 55 個中文字。
5. 三個選項都要短，單個選項不要超過 8 個中文字。
6. 三個選項必須不同，且只能有一個正確答案。
7. correctIndex 必須是 0、1、2，代表 options 中正確答案的位置。
8. hint 必須根據這一次生成的問題和正確答案產生，可以幫玩家回想，但不要直接說出完整答案。
9. targetObject 請寫這題主要觀察的物件或人物。
10. questionType 可自由填寫，例如：顏色、物件、數量、位置、動作、細節、其他。
11. 請只輸出 JSON，不要 markdown，不要解釋。`;

    const responseSchema = {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: {
          type: 'array',
          items: { type: 'string' },
          minItems: 3,
          maxItems: 3
        },
        correctIndex: { type: 'integer', minimum: 0, maximum: 2 },
        hint: { type: 'string' },
        targetObject: { type: 'string' },
        questionType: { type: 'string', enum: QUESTION_TYPES }
      },
      required: ['question', 'options', 'correctIndex', 'hint', 'targetObject', 'questionType']
    };

    let lastText = '';
    let lastError = null;

    // 單次 endpoint 內先嘗試 3 次；如果仍失敗，前端會繼續自動重新呼叫，直到成功。
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: [
            { inlineData: { mimeType, data: base64Image } },
            { text: `${prompt}\n\n這是第 ${attempt} 次生成，請和前一次盡量不同。` }
          ],
          config: {
            systemInstruction,
            temperature: 1.05,
            topP: 0.95,
            responseMimeType: 'application/json',
            responseSchema
          }
        });

        lastText = response.text;
        const parsed = extractJson(response.text);

        if (validateQuestionData(parsed)) {
          const questionData = normalizeGeminiQuestion(parsed);
          console.log(`[Gemini] ${levelId || 'level'} 出題成功：${questionData.question}`);
          return res.json({
            success: true,
            source: 'gemini',
            model: GEMINI_MODEL,
            questionData
          });
        }

        lastError = new Error('Gemini 回傳格式驗證失敗');
        console.warn(`[Gemini] 第 ${attempt} 次回傳格式驗證失敗：`, response.text);
      } catch (error) {
        lastError = error;
        console.warn(`[Gemini] 第 ${attempt} 次呼叫失敗：`, error?.message || error);
      }
    }

    return res.status(200).json(buildErrorResponse(
      'invalid_or_failed_gemini_response',
      lastError?.message || lastText || 'Gemini 生成失敗'
    ));
  } catch (error) {
    console.error('[Gemini] API endpoint 發生錯誤：', error?.message || error);
    return res.status(200).json(buildErrorResponse(
      'gemini_api_error',
      error?.message || 'Gemini API 呼叫失敗'
    ));
  }
});

app.listen(PORT, () => {
  console.log(`🎮 遊戲伺服器已啟動：http://localhost:${PORT}`);
  console.log(`🧠 Gemini model：${GEMINI_MODEL}`);
  console.log('🎲 模式：AI-only 隨機出題，沒有預設題目 fallback。');
  const keySource = (HARDCODED_GEMINI_API_KEY.trim() && HARDCODED_GEMINI_API_KEY !== 'PASTE_YOUR_GEMINI_API_KEY_HERE')
    ? 'server.js hardcoded'
    : (process.env.GEMINI_API_KEY ? '.env' : 'none');
  console.log(`🔑 Gemini key source：${keySource}`);
  if (!getGeminiApiKey()) {
    console.warn('⚠️  Gemini API key 未設定：AI-only 模式會一直重新嘗試，但不會產生預設題目。請在 server.js 的 HARDCODED_GEMINI_API_KEY 填入 key。');
  }
});
