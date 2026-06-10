# 互動窗戶擦拭記憶遊戲｜Gemini AI-only 本地版

這一版是本地展示用版本。遊戲會在每一關根據圖片呼叫 Gemini，隨機生成：

- 一題觀察記憶問題
- 三個答案選項
- 正確答案索引
- 5 秒後顯示的 AI 提示

## 這版的重要差異

- 不再使用預設固定問題。
- 每次進入關卡都會讓 Gemini 根據圖片生成新題目。
- Gemini 第一次失敗時，前端會自動重新呼叫 API，直到成功為止。
- 答錯後按「再試一次」會保留同一題，不會重新生成。
- 答錯後會直接顯示正確答案提示。
- 5 秒未作答時，AI 角色會顯示 Gemini 針對當次題目生成的提示。

## API key 設定方式

打開 `server.js`，找到：

```js
const HARDCODED_GEMINI_API_KEY = 'PASTE_YOUR_GEMINI_API_KEY_HERE';
```

改成：

```js
const HARDCODED_GEMINI_API_KEY = '你的 Gemini API key';
```

這種方式只適合本地展示，不要把寫入真實 API key 的 `server.js` 上傳到公開 GitHub。

你也可以使用 `.env`：

```env
GEMINI_API_KEY=你的 Gemini API key
GEMINI_MODEL=gemini-2.0-flash
```

如果 `server.js` 寫死 key 和 `.env` 都有設定，會優先使用 `server.js` 的 hardcoded key。

## 本地啟動

進入專案資料夾後執行：

```bash
npm install
npm start
```

然後開啟：

```text
http://localhost:3000
```

不要直接點開 `index.html`，也不要使用 `python -m http.server`，因為那樣不會啟動 Gemini API。

## 檢查 AI 是否成功啟動

先打開：

```text
http://localhost:3000/api/health
```

如果看到：

```json
{
  "ok": true,
  "geminiKeyConfigured": true,
  "mode": "ai-only-no-fallback"
}
```

代表 server 有讀到 Gemini API key。

玩到問答階段時，可以在 Chrome DevTools → Network 裡查看：

```text
/api/generate-question
```

成功時 response 會出現：

```json
"source": "gemini"
```

## 如果一直停在 AI 出題中

代表 Gemini 尚未成功回傳可用 JSON。常見原因：

1. API key 沒有填好。
2. Gemini key 沒有權限。
3. `GEMINI_MODEL` 模型名稱不支援。
4. 網路無法連到 Gemini。
5. 圖片路徑錯誤。

這版沒有預設題目 fallback，所以 AI 失敗時會一直自動重試。

## 圖片檔名

目前所有圖片已改成英文檔名，避免中文路徑在不同系統中出錯。

```text
Image/ato-bor.png
Image/wang-mama.png
Image/uncle.png
Image/acai-bor.png
Image/crossing-kid.png
Image/grandson1.png
Image/grandson2.png
Image/grandson3.png
Image/granddaughter1.png
Image/granddaughter2.png
Image/granddaughter3.png
Image/window-frame-1.png
Image/window-frame-1-2.png
Image/water_drops.jpg
```
