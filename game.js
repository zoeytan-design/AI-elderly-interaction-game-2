/**
 * 互動窗戶擦拭遊戲 - 核心邏輯 (game.js)
 *
 * 【四階段遊戲流程】：
 *   Stage 1 'wiping'    → 手勢擦霧，同時偵測紅色水瓶與阿土伯是否出現
 *   Stage 2 'countdown' → 霧氣消失，倒數讀條由右向左縮減 10 秒，相機關閉
 *   Stage 3 'question'  → 讀條歸零後出現三個選項按鈕，手勢控制選擇答案
 *   Stage 4 'result'    → 玩家選完後顯示結果文字 + 下一題 / 今天先這樣 按鈕
 *
 * 【手勢控制機制】：
 *   - 擦窗戶：用食指移動擦除霧氣
 *   - 問答：指向按鈕 1.2 秒自動選擇，或握拳確認選擇
 */

// ==========================================================================
// ★【遊戲自訂參數設定區 - 後台調整區】★
// ==========================================================================
const GAME_CONFIG = {
    WIPE_SHAPE: 'square',
    WIPE_SIZE: 140,
    LEFT_PANE_THRESHOLD: 50,
    RIGHT_PANE_THRESHOLD: 50,
    COUNTDOWN_TIME: 10,
};

const LEVELS = [
    {
        id: '阿土伯',
        name: '阿土伯',
        image: 'Image/ato-bor.png',
        alt: '阿土伯'
    },
    {
        id: '王媽媽',
        name: '王媽媽',
        image: 'Image/wang-mama.png',
        alt: '王媽媽'
    },
    {
        id: '不要叫我叔叔',
        name: '不要叫我叔叔',
        image: 'Image/uncle.png',
        alt: '不要叫我叔叔'
    },
    {
        id: '阿財伯',
        name: '阿財伯',
        image: 'Image/acai-bor.png',
        alt: '阿財伯'
    },
    {
        id: '導護小孩',
        name: '導護小孩',
        image: 'Image/crossing-kid.png',
        alt: '導護小孩'
    }
];

let currentLevelIndex = 0;
let wipeFallbackTimeoutId = null;

// AI 出題相關狀態變數
let currentQuestionData = null;
let hintTimerId = null;
let hintShown = false;
let isGeneratingQuestion = false;
let currentQuestionPromise = null;
let aiGenerationAttempt = 0;
let aiLoadingMessageHandler = null;

// ============================================================
// AI-only 出題輔助函式（沒有預設題目 fallback）
// ============================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function setAILoadingMessage(message) {
    console.log(message);
    if (typeof aiLoadingMessageHandler === 'function') {
        aiLoadingMessageHandler(message);
    }
}

function normalizeQuestionData(data) {
    if (!data || typeof data !== 'object') {
        throw new Error('AI 回傳內容不是物件');
    }
    if (!data.question || typeof data.question !== 'string') {
        throw new Error('AI 回傳缺少 question');
    }
    if (!Array.isArray(data.options) || data.options.length !== 3) {
        throw new Error('AI 回傳 options 不是 3 個');
    }
    if (!data.options.every(option => typeof option === 'string' && option.trim())) {
        throw new Error('AI 回傳 options 有空值');
    }
    if (![0, 1, 2].includes(Number(data.correctIndex))) {
        throw new Error('AI 回傳 correctIndex 錯誤');
    }
    if (!data.hint || typeof data.hint !== 'string') {
        throw new Error('AI 回傳缺少 hint');
    }

    return {
        question: data.question.trim(),
        options: data.options.map(option => option.trim()).slice(0, 3),
        correctIndex: Number(data.correctIndex),
        hint: data.hint.trim(),
        targetObject: data.targetObject || '',
        questionType: data.questionType || '',
        source: 'gemini'
    };
}

// ============================================================
// 圖片轉 base64（GitHub Pages 靜態版用，前端直接讀取圖片）
// ============================================================
async function imageToBase64(imagePath) {
    const response = await fetch(imagePath);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            // 去掉 "data:image/png;base64," 前綴，只留純 base64
            const base64 = reader.result.split(',')[1];
            resolve({ base64, mimeType: blob.type || 'image/png' });
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
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
        try { return JSON.parse(match[0]); } catch (_) { return null; }
    }
}

function validateQuestionData(data) {
    if (!data || typeof data !== 'object') return false;
    if (typeof data.question !== 'string' || !data.question.trim()) return false;
    if (!Array.isArray(data.options) || data.options.length !== 3) return false;
    if (!data.options.every(opt => typeof opt === 'string' && opt.trim())) return false;
    if (![0, 1, 2].includes(Number(data.correctIndex))) return false;
    if (typeof data.hint !== 'string' || !data.hint.trim()) return false;
    const unique = new Set(data.options.map(o => o.trim()));
    if (unique.size !== 3) return false;
    return true;
}

async function generateQuestionForLevel(level) {
    isGeneratingQuestion = true;
    aiGenerationAttempt = 0;

    while (true) {
        aiGenerationAttempt += 1;
        setAILoadingMessage(`AI 正在看圖片出題中...第 ${aiGenerationAttempt} 次嘗試`);

        try {
            const apiKey = window._geminiApiKey;
            if (!apiKey) throw new Error('尚未輸入 Gemini API Key');

            const { base64, mimeType } = await imageToBase64(level.image);

            const GEMINI_MODEL = 'gemini-2.0-flash';
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

            const prompt = `你是高齡友善互動記憶遊戲的 AI 出題系統。玩家會先看一張窗外圖片 10 秒，之後圖片會被水滴遮住，玩家必須根據記憶回答問題。

關卡名稱：${level.id || level.name}
隨機種子：${Date.now()}-${Math.random()}

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
11. 請只輸出純 JSON，不要加 markdown 反引號，不要任何解釋文字。

這是第 ${aiGenerationAttempt} 次生成，請和前一次盡量不同。

回傳格式（只輸出這個 JSON，其他什麼都不要）：
{"question":"...","options":["...","...","..."],"correctIndex":0,"hint":"...","targetObject":"...","questionType":"..."}`;

            const body = {
                contents: [
                    {
                        role: 'user',
                        parts: [
                            { inline_data: { mime_type: mimeType, data: base64 } },
                            { text: prompt }
                        ]
                    }
                ],
                generationConfig: {
                    temperature: 1.05,
                    topP: 0.95
                }
            };

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errJson = await response.json().catch(() => null);
                const errMsg = errJson?.error?.message || `HTTP ${response.status}`;
                const errStatus = response.status;

                // 針對常見錯誤給出明確提示
                if (errStatus === 400) throw new Error(`API Key 格式錯誤或請求有問題：${errMsg}`);
                if (errStatus === 401 || errStatus === 403) throw new Error(`API Key 無效或沒有權限，請確認 Key 是從 AI Studio 申請的：${errMsg}`);
                if (errStatus === 429) throw new Error(`超過 Gemini 免費使用上限，請稍後再試：${errMsg}`);
                throw new Error(`Gemini API 回傳 ${errStatus}：${errMsg}`);
            }

            const result = await response.json();
            const rawText = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';

            if (!rawText) {
                const finishReason = result?.candidates?.[0]?.finishReason || '未知';
                throw new Error(`Gemini 沒有回傳內容，finishReason: ${finishReason}`);
            }

            const parsed = extractJson(rawText);

            if (!validateQuestionData(parsed)) {
                console.warn('Gemini 原始回傳：', rawText);
                throw new Error('Gemini 回傳格式驗證失敗');
            }

            const questionData = normalizeQuestionData(parsed);
            console.log(`✅ Gemini 題目生成成功：${level.name}`, questionData);
            isGeneratingQuestion = false;
            return questionData;

        } catch (error) {
            console.warn(`Gemini 第 ${aiGenerationAttempt} 次出題失敗：`, error.message);
            setAILoadingMessage(`出題失敗（${error.message}），自動重試第 ${aiGenerationAttempt + 1} 次...`);
            await sleep(Math.min(1800 + aiGenerationAttempt * 300, 4000));
        }
    }
}

async function getQuestionBeforeQuestionStage(level) {
    if (currentQuestionData) return currentQuestionData;

    if (!currentQuestionPromise) {
        currentQuestionPromise = generateQuestionForLevel(level);
    }

    currentQuestionData = await currentQuestionPromise;
    return currentQuestionData;
}

function resetAIQuestionState() {
    currentQuestionData = null;
    currentQuestionPromise = null;
    hintShown = false;
    aiGenerationAttempt = 0;
    isGeneratingQuestion = false;
}

function getCorrectAnswerText() {
    if (!currentQuestionData || !Array.isArray(currentQuestionData.options)) return '';
    return currentQuestionData.options[currentQuestionData.correctIndex] || '';
}

function formatOptionText(text) {
    if (!text) return '';
    const clean = String(text).replace(/\s/g, '');
    if (clean.length <= 4) {
        return clean.split('').join('　');
    }
    return clean;
}

// ==========================================================================
// ★【對話框文字設定區 - 後台調整區】★
// ==========================================================================
const DIALOGUE_TEXT = {
    wiping:    '{userTitle}，窗戶起霧了，擦一下吧。',
    countdown: '{userTitle}！你要記清楚窗戶外面有甚麼喔！！',
    question:  '那個人在推著車子，車上放了一個好大的瓶子，還一直冒煙耶！那是什麼顏色的瓶子呀？',
    correct:   '{userTitle}你答對了！你很棒餒！要不要繼續下一題？',
    wrong:     '哎呀，答錯了！沒關係，再想想看喔！',
};

window.addEventListener('DOMContentLoaded', () => {
    const canvas       = document.getElementById('fog-canvas');
    const ctx          = canvas.getContext('2d');
    const windowWrapper = document.getElementById('window-wrapper');
    const windowBgImage = document.getElementById('window-bg-image');
    const videoElement              = document.getElementById('webcam-video');
    const gesturePointersContainer  = document.getElementById('gesture-pointers');
    const dialogueTextEl    = document.getElementById('dialogue-text-element');
    const countdownContainer = document.getElementById('countdown-container');
    const countdownProgress  = document.getElementById('countdown-progress');
    const qaOverlay          = document.getElementById('qa-overlay');
    const qaButtons          = document.querySelectorAll('.qa-btn');
    const wrongResultOverlay = document.getElementById('wrong-result-overlay');
    const wrongResultImage   = document.getElementById('wrong-result-image');
    const btnRetry           = document.getElementById('btn-retry');
    const btnGiveUp          = document.getElementById('btn-giveup');
    const resultActions      = document.getElementById('result-actions');
    const btnNext            = document.getElementById('btn-next');
    const btnHome            = document.getElementById('btn-home');
    const cameraErrorOverlay = document.getElementById('camera-error-overlay');
    const cameraErrorMessage = document.getElementById('camera-error-message');
    const cameraErrorRetry   = document.getElementById('camera-error-retry');
    const startupOverlay        = document.getElementById('startup-overlay');
    const startGameBtn         = document.getElementById('start-game-btn');
    const startupCharacterImage = document.getElementById('startup-character-image');
    const nameInput            = document.getElementById('grandchild-name-input');
    const userGenderInputs     = document.querySelectorAll('input[name="user-gender"]');
    const grandchildGenderInputs = document.querySelectorAll('input[name="grandchild-gender"]');
    const nameBadge            = document.getElementById('name-badge');
    const characterImage       = document.getElementById('character-image');

    aiLoadingMessageHandler = (message) => {
        if (gameState === 'question-loading' || gameState === 'countdown') {
            dialogueTextEl.classList.add('small');
            dialogueTextEl.textContent = message;
        }
    };

    // ============================================================
    // API Key 輸入處理
    // ============================================================
    const apiKeyInput   = document.getElementById('gemini-api-key-input');
    const apiKeyToggle  = document.getElementById('api-key-toggle-btn');
    const apiKeyError   = document.getElementById('api-key-error');

    if (apiKeyToggle && apiKeyInput) {
        apiKeyToggle.addEventListener('click', () => {
            const isHidden = apiKeyInput.type === 'password';
            apiKeyInput.type = isHidden ? 'text' : 'password';
            apiKeyToggle.textContent = isHidden ? '🙈' : '👁';
        });
    }

    if (apiKeyInput) {
        apiKeyInput.addEventListener('input', () => {
            if (apiKeyError) apiKeyError.classList.add('hidden');
        });
    }

    let userGender = 'female';
    let grandchildGender = 'male';
    let grandchildName = '王小明';
    let userTitle = '阿罵';
    let gameStarted = false;
    let cameraInitialized = false;

    function updateGameScale() {
        const scale = Math.min(
            window.innerWidth / 1600,
            window.innerHeight / 950,
            1
        );
        document.documentElement.style.setProperty('--game-scale', String(scale));
    }

    updateGameScale();
    window.addEventListener('resize', updateGameScale);

    const offscreen = document.createElement('canvas');
    offscreen.width  = 40;
    offscreen.height = 25;
    const oCtx = offscreen.getContext('2d');

    const waterDropsImg = new Image();
    let isTextureLoaded = false;

    let gameState        = 'wiping';
    let countdownInterval = null;
    let lastCheckTime    = 0;

    let wipeFallbackStart   = null;
    let wipeGestureCount    = 0;
    let pointerDown         = false;
    let pointerLastX        = null;
    let pointerLastY        = null;

    // 手勢相關變數（需在 resetFog 之前宣告）
    let isWebcamActive = false;
    let cameraInstance = null;
    let gestureLastX   = null;
    let gestureLastY   = null;
    let fingerPoints = [];
    let currentHighlightBtn = null;
    let lastSelectionTime = 0;
    let hoveredButtonTime = 0;

    waterDropsImg.onload = () => {
        isTextureLoaded = true;
        console.log('💧 靜態霧氣紋理載入成功，啟動畫布...');
        resizeCanvas();
    };
    waterDropsImg.src = 'Image/water_drops.jpg';
    if (waterDropsImg.complete) waterDropsImg.onload();

    function replacePlaceholders(text) {
        return text
            .replace(/\{userTitle\}/g, userTitle)
            .replace(/\{grandchildName\}/g, grandchildName);
    }

    function getCheckedValue(inputs, fallback) {
        return Array.from(inputs).find(input => input.checked)?.value || fallback;
    }

    function getGrandchildAvatar() {
        return grandchildGender === 'female' ? 'Image/granddaughter1.png' : 'Image/grandson1.png';
    }

    function updateCharacterImages() {
        const avatarFile = getGrandchildAvatar();
        const avatarAlt = grandchildGender === 'female' ? '孫女' : '孫子';

        if (characterImage) {
            characterImage.src = avatarFile;
            characterImage.alt = avatarAlt;
        }

        if (startupCharacterImage) {
            startupCharacterImage.src = avatarFile;
            startupCharacterImage.alt = avatarAlt;
        }
    }

    function updateProfilePreview({ updateDialogue = false } = {}) {
        userGender = getCheckedValue(userGenderInputs, 'female');
        grandchildGender = getCheckedValue(grandchildGenderInputs, 'male');
        grandchildName = nameInput.value.trim() || '王小明';
        userTitle = userGender === 'male' ? '阿公' : '阿罵';

        if (nameBadge) nameBadge.textContent = grandchildName;
        updateCharacterImages();

        if (updateDialogue && dialogueTextEl) {
            dialogueTextEl.classList.remove('small');
            dialogueTextEl.textContent = replacePlaceholders(DIALOGUE_TEXT.wiping);
        }
    }

    function applyProfileSettings() {
        updateProfilePreview({ updateDialogue: true });
    }

    function updateOptionSelectionStyles() {
        document.querySelectorAll('.option-pill').forEach(label => {
            const input = label.querySelector('input[type="radio"]');
            label.classList.toggle('selected', Boolean(input?.checked));
        });
    }

    function handleStartupOptionChange() {
        updateOptionSelectionStyles();
        updateProfilePreview();
    }

    userGenderInputs.forEach(input => input.addEventListener('change', handleStartupOptionChange));
    grandchildGenderInputs.forEach(input => input.addEventListener('change', handleStartupOptionChange));
    if (nameInput) {
        nameInput.addEventListener('input', () => updateProfilePreview());
    }
    updateOptionSelectionStyles();
    updateProfilePreview({ updateDialogue: true });

    startGameBtn.addEventListener('click', () => {
        // 檢查 API Key
        const enteredKey = apiKeyInput ? apiKeyInput.value.trim() : '';
        if (!enteredKey) {
            if (apiKeyError) apiKeyError.classList.remove('hidden');
            if (apiKeyInput) apiKeyInput.focus();
            return;
        }
        // 存在記憶體，不寫入任何持久化儲存
        window._geminiApiKey = enteredKey;

        applyProfileSettings();
        resetAIQuestionState({ clearCache: true });
        currentLevelIndex = 0;
        gameStarted = true;
        if (startupOverlay) startupOverlay.classList.add('hidden');
        if (!cameraInitialized) {
            initMediapipe();
        } else if (cameraInstance && typeof cameraInstance.start === 'function') {
            cameraInstance.start();
            isWebcamActive = true;
            hideCameraError();
        }
        resizeCanvas();
    });

    function resizeCanvas() {
        if (!canvas || !windowWrapper) return;
        const w = windowWrapper.clientWidth;
        const h = windowWrapper.clientHeight;
        canvas.width  = w > 0 ? w : 1080;
        canvas.height = h > 0 ? h : 667;
        console.log(`📐 畫布大小重置為: ${canvas.width}x${canvas.height}`);
        resetFog();
    }

    function resetFog() {
        if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
        gameState = 'wiping';
        hideCameraError();
        fingerPoints = [];
        lastSelectionTime = 0;
        hoveredButtonTime = 0;
        if (currentHighlightBtn) {
            currentHighlightBtn.classList.remove('gesture-hover');
            currentHighlightBtn = null;
        }
        wipeFallbackStart = null;
        wipeGestureCount = 0;
        if (wipeFallbackTimeoutId) {
            clearTimeout(wipeFallbackTimeoutId);
            wipeFallbackTimeoutId = null;
        }
        pointerDown = false;
        pointerLastX = null;
        pointerLastY = null;
        countdownContainer.classList.add('hidden');
        canvas.classList.remove('hidden');
        qaOverlay.classList.add('hidden');
        wrongResultOverlay.classList.add('hidden');
        resultActions.classList.add('hidden');
        clearHintTimer();
        hideAIHint();
        dialogueTextEl.classList.remove('small');
        dialogueTextEl.textContent = replacePlaceholders(DIALOGUE_TEXT.wiping);
        if (windowBgImage) {
            const level = LEVELS[currentLevelIndex];
            windowBgImage.src = level.image;
            windowBgImage.alt = `戶外 ${level.alt}`;
        }
        if (wrongResultImage) {
            const level = LEVELS[currentLevelIndex];
            wrongResultImage.src = level.image;
            wrongResultImage.alt = level.alt;
        }
        qaButtons.forEach(btn => btn.classList.remove('correct-flash', 'wrong-flash'));
        if (gameStarted) {
            isWebcamActive = true;
            if (!videoElement.srcObject || !videoElement.srcObject.active) {
                console.log('🔄 重新初始化 Mediapipe 與鏡頭串流...');
                initMediapipe();
            }
        }
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = 'rgba(235, 240, 245, 1.0)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (isTextureLoaded) {
            ctx.globalAlpha = 0.5;
            ctx.drawImage(waterDropsImg, 0, 0, canvas.width, canvas.height);
            ctx.globalAlpha = 1.0;
        }
        ctx.restore();
    }

    function showCameraError(message) {
        if (!cameraErrorOverlay || !cameraErrorMessage) return;
        cameraErrorMessage.textContent = message || '請使用本地伺服器開啟本遊戲並允許相機權限。';
        cameraErrorOverlay.classList.remove('hidden');
    }

    function showStartupScreen() {
        gameStarted = false;
        resetAIQuestionState({ clearCache: true });
        updateOptionSelectionStyles();
        updateProfilePreview({ updateDialogue: true });
        if (startupOverlay) startupOverlay.classList.remove('hidden');
        stopCamera(true);
        wrongResultOverlay.classList.add('hidden');
        qaOverlay.classList.add('hidden');
        resultActions.classList.add('hidden');
        gameState = 'wiping';
        currentLevelIndex = 0;
        resetFog();
    }

    function hideCameraError() {
        if (!cameraErrorOverlay) return;
        cameraErrorOverlay.classList.add('hidden');
    }

    window.addEventListener('resize', resizeCanvas);

    cameraErrorRetry.addEventListener('click', () => {
        hideCameraError();
        initMediapipe();
    });

    canvas.addEventListener('pointerdown', handlePointerStart);
    canvas.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);

    function handlePointerStart(event) {
        if (gameState !== 'wiping') return;
        pointerDown = true;
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        pointerLastX = x;
        pointerLastY = y;
        registerWipeAction();
        wipeSingleSpot(x, y);
        checkClearedPercentage();
        maybeForceCountdownFallback();
    }

    function handlePointerMove(event) {
        if (gameState !== 'wiping' || !pointerDown) return;
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        if (pointerLastX !== null && pointerLastY !== null) {
            wipeContinuousPath(pointerLastX, pointerLastY, x, y);
        } else {
            wipeSingleSpot(x, y);
        }
        pointerLastX = x;
        pointerLastY = y;
        registerWipeAction();
        checkClearedPercentage();
        maybeForceCountdownFallback();
    }

    function handlePointerEnd() {
        pointerDown = false;
        pointerLastX = null;
        pointerLastY = null;
    }

    function registerWipeAction() {
        if (!wipeFallbackStart) {
            wipeFallbackStart = Date.now();
            if (wipeFallbackTimeoutId) {
                clearTimeout(wipeFallbackTimeoutId);
            }
            wipeFallbackTimeoutId = setTimeout(() => {
                if (gameState === 'wiping' && wipeFallbackStart) {
                    console.log('⏱ 連續擦拭 10 秒，進入倒數階段');
                    startCountdownState();
                }
            }, 10000);
        }
        wipeGestureCount += 1;
    }

    function maybeForceCountdownFallback() {
        if (gameState !== 'wiping' || !wipeFallbackStart) return;
        const elapsed = (Date.now() - wipeFallbackStart) / 1000;
        if (elapsed >= 10) {
            console.log(`⏩ 使用者已擦拭 ${Math.floor(elapsed)} 秒，進入倒數階段`);
            startCountdownState();
            return;
        }
        if (wipeGestureCount >= 35) {
            console.log('⏩ 擦拭手勢次數達到備援門檻，但仍以時間為主觸發倒數');
        }
    }

    function wipeSingleSpot(x, y) {
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = 'rgba(0,0,0,1)';
        const size = GAME_CONFIG.WIPE_SIZE;
        if (GAME_CONFIG.WIPE_SHAPE === 'square') {
            ctx.fillRect(x - size / 2, y - size / 2, size, size);
        } else {
            ctx.beginPath();
            ctx.arc(x, y, size / 2, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    function wipeContinuousPath(x1, y1, x2, y2) {
        const size = GAME_CONFIG.WIPE_SIZE;
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = 'rgba(0,0,0,1)';
        if (GAME_CONFIG.WIPE_SHAPE === 'square') {
            const dx = x2 - x1, dy = y2 - y1;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const steps = Math.ceil(dist / 2);
            for (let i = 0; i <= steps; i++) {
                const t = steps === 0 ? 0 : i / steps;
                ctx.fillRect(x1 + dx * t - size / 2, y1 + dy * t - size / 2, size, size);
            }
        } else {
            ctx.lineWidth = size;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        }
        ctx.restore();
    }

    function checkClearedPercentage() {
        try {
            if (gameState !== 'wiping') return;
            if (canvas.width <= 0 || canvas.height <= 0) return;
            const now = Date.now();
            if (now - lastCheckTime < 300) return;
            lastCheckTime = now;
            oCtx.imageSmoothingEnabled = false;
            oCtx.mozImageSmoothingEnabled = false;
            oCtx.webkitImageSmoothingEnabled = false;
            oCtx.msImageSmoothingEnabled = false;
            oCtx.clearRect(0, 0, 40, 25);
            oCtx.drawImage(canvas, 0, 0, 40, 25);
            const data = oCtx.getImageData(0, 0, 40, 25).data;
            let thermosCleared = 0;
            const thermosTotal = (22 - 10 + 1) * (20 - 5 + 1);
            let oldmanCleared = 0;
            const oldmanTotal = (37 - 24 + 1) * (20 - 5 + 1);
            for (let y = 5; y <= 20; y++) {
                for (let x = 10; x <= 22; x++) {
                    if (data[(y * 40 + x) * 4 + 3] < 150) thermosCleared++;
                }
                for (let x = 24; x <= 37; x++) {
                    if (data[(y * 40 + x) * 4 + 3] < 150) oldmanCleared++;
                }
            }
            const thermosPercent = (thermosCleared / thermosTotal) * 100;
            const oldmanPercent  = (oldmanCleared  / oldmanTotal)  * 100;
            console.log(`🧹 水瓶: ${thermosPercent.toFixed(1)}% / 阿土伯: ${oldmanPercent.toFixed(1)}%`);
            if (oldmanPercent >= GAME_CONFIG.RIGHT_PANE_THRESHOLD) {
                console.log(`✅ 阿土伯區域已清除 ${oldmanPercent.toFixed(1)}%，進入倒數`);
                startCountdownState();
            }
        } catch (err) {
            console.error('⚠️ 離屏透明度檢測模組發生異常:', err);
        }
    }

    // ============================================================
    // AI 提示泡泡相關函式
    // ============================================================

    function prepareQuestionForCurrentLevel() {
        const level = LEVELS[currentLevelIndex];
        if (!currentQuestionPromise) {
            currentQuestionPromise = generateQuestionForLevel(level)
                .then(questionData => {
                    currentQuestionData = questionData;
                    return questionData;
                });
        }
        return currentQuestionPromise;
    }

    function startHintTimer() {
        clearHintTimer();
        hintShown = false;
        hintTimerId = setTimeout(() => {
            if (gameState !== 'question') return;
            if (hintShown) return;
            if (currentHighlightBtn) return;
            showAIHint();
        }, 5000);
    }

    function clearHintTimer() {
        if (hintTimerId) {
            clearTimeout(hintTimerId);
            hintTimerId = null;
        }
    }

    function showAIHint() {
        if (!currentQuestionData || !currentQuestionData.hint) return;
        hintShown = true;
        const hintText = replacePlaceholders(currentQuestionData.hint);
        const hintBubble = document.getElementById('ai-hint-bubble');
        const hintTextEl = document.getElementById('ai-hint-text');
        if (hintBubble && hintTextEl) {
            hintTextEl.textContent = hintText;
            hintBubble.classList.remove('hidden');
            return;
        }
        dialogueTextEl.classList.add('small');
        dialogueTextEl.textContent = `提示：${hintText}`;
    }

    function hideAIHint() {
        const hintBubble = document.getElementById('ai-hint-bubble');
        if (hintBubble) {
            hintBubble.classList.add('hidden');
        }
    }

    function startCountdownState() {
        if (gameState !== 'wiping') return;
        gameState = 'countdown';
        console.log('🎉 進入第二階段：倒數記憶！');

        prepareQuestionForCurrentLevel();

        canvas.classList.add('hidden');
        stopCamera(false);
        countdownContainer.classList.remove('hidden');
        countdownProgress.style.transition = 'none';
        countdownProgress.style.width = '100%';
        requestAnimationFrame(() => {
            countdownProgress.style.transition = 'width 0.08s linear';
        });
        dialogueTextEl.classList.remove('small');
        dialogueTextEl.textContent = replacePlaceholders(DIALOGUE_TEXT.countdown);
        clearWipeFallbackTimer();

        let timeLeft = GAME_CONFIG.COUNTDOWN_TIME;
        const totalDuration = GAME_CONFIG.COUNTDOWN_TIME;

        countdownInterval = setInterval(() => {
            timeLeft -= 0.05;
            const fillPct = Math.max(0, (timeLeft / totalDuration) * 100);
            countdownProgress.style.width = `${fillPct}%`;
            if (timeLeft <= 0) {
                clearInterval(countdownInterval);
                countdownInterval = null;
                countdownProgress.style.width = '0%';
                setTimeout(startQuestionState, 300);
            }
        }, 50);
    }

    function clearWipeFallbackTimer() {
        if (wipeFallbackTimeoutId) {
            clearTimeout(wipeFallbackTimeoutId);
            wipeFallbackTimeoutId = null;
        }
    }

    async function startQuestionState() {
        console.log('❓ 進入第三階段：AI 出題 / 問答！');

        const level = LEVELS[currentLevelIndex];

        countdownContainer.classList.add('hidden');
        qaOverlay.classList.add('hidden');
        hideAIHint();
        stopCamera(false);

        if (!currentQuestionData) {
            gameState = 'question-loading';
            dialogueTextEl.classList.add('small');
            dialogueTextEl.textContent = 'AI 正在根據圖片生成新的問題，請稍等...';
            currentQuestionData = await getQuestionBeforeQuestionStage(level);
        }

        gameState = 'question';
        console.log('❓ 進入第三階段：問答！', currentQuestionData);

        qaOverlay.classList.remove('hidden');

        dialogueTextEl.classList.add('small');
        dialogueTextEl.textContent = replacePlaceholders(currentQuestionData.question);

        qaButtons.forEach((btn, index) => {
            const optionText = currentQuestionData.options[index];
            btn.textContent = formatOptionText(optionText);
            btn.dataset.answer = index === currentQuestionData.correctIndex ? 'correct' : 'wrong';
        });

        if (windowBgImage) {
            windowBgImage.src = 'Image/water_drops.jpg';
            windowBgImage.alt = '遮蔽圖片';
        }

        qaButtons.forEach(btn => btn.classList.remove('correct-flash', 'wrong-flash', 'gesture-hover'));
        currentHighlightBtn = null;
        hoveredButtonTime = 0;

        hideAIHint();
        startHintTimer();

        isWebcamActive = true;
        console.log('📸 手勢控制已啟動，指向按鈕以選擇答案...');
        if (!cameraInitialized) {
            initMediapipe();
        }
    }

    qaButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            if (gameState !== 'question') return;
            gameState = 'result';
            clearHintTimer();
            hideAIHint();
            const isCorrect = btn.dataset.answer === 'correct';
            btn.classList.add(isCorrect ? 'correct-flash' : 'wrong-flash');
            setTimeout(() => startResultState(isCorrect), 600);
        });
    });

    function startResultState(isCorrect) {
        gameState = 'result';
        console.log(`🏆 進入第四階段：結果 (${isCorrect ? '答對' : '答錯'})`);
        const level = LEVELS[currentLevelIndex];
        if (windowBgImage && level) {
            windowBgImage.src = level.image;
            windowBgImage.alt = `戶外 ${level.alt}`;
        }
        qaOverlay.classList.add('hidden');
        wrongResultOverlay.classList.add('hidden');
        resultActions.classList.add('hidden');
        clearHintTimer();
        hideAIHint();
        dialogueTextEl.classList.remove('small');
        if (isCorrect) {
            dialogueTextEl.textContent = replacePlaceholders(DIALOGUE_TEXT.correct);
            resultActions.classList.remove('hidden');
        } else {
            const answerText = getCorrectAnswerText();
            const answerHint = answerText
                ? `{userTitle}，答案是「${answerText}」喔！我們再看一次，等一下再試試看。`
                : DIALOGUE_TEXT.wrong;
            dialogueTextEl.textContent = replacePlaceholders(answerHint);
            wrongResultOverlay.classList.remove('hidden');
        }
    }

    btnRetry.addEventListener('click', () => {
        if (gameState !== 'result') return;
        console.log('▶ 再試一次，回到問答畫面');
        wrongResultOverlay.classList.add('hidden');
        startQuestionState();
    });

    btnGiveUp.addEventListener('click', () => {
        if (gameState !== 'result') return;
        console.log('🏠 先回到主畫面');
        clearHintTimer();
        hideAIHint();
        wrongResultOverlay.classList.add('hidden');
        showStartupScreen();
    });

    btnNext.addEventListener('click', () => {
        if (gameState !== 'result') return;
        resetAIQuestionState();
        clearHintTimer();
        hideAIHint();
        if (currentLevelIndex < LEVELS.length - 1) {
            currentLevelIndex += 1;
            console.log(`▶ 進入下一關：${LEVELS[currentLevelIndex].name}`);
        } else {
            currentLevelIndex = 0;
            console.log('▶ 已完成所有關卡，返回第一關');
        }
        resizeCanvas();
    });

    btnHome.addEventListener('click', () => {
        if (gameState !== 'result') return;
        console.log('🏠 今天先這樣，回到主畫面...');
        clearHintTimer();
        hideAIHint();
        showStartupScreen();
    });

    function stopCamera(stopStream = false) {
        isWebcamActive = false;
        gesturePointersContainer.innerHTML = '';
        fingerPoints = [];
        lastSelectionTime = 0;
        if (currentHighlightBtn) {
            currentHighlightBtn.classList.remove('gesture-hover');
            currentHighlightBtn = null;
        }
        if (stopStream && cameraInstance && typeof cameraInstance.stop === 'function') {
            try {
                cameraInstance.stop();
                console.log('📹 Mediapipe 鏡頭已停止。');
            } catch (stopError) {
                console.warn('停止鏡頭時發生錯誤：', stopError);
            }
        }
    }

    function initMediapipe() {
        console.log('正在啟動 Mediapipe 手勢後台...');
        const hands = new Hands({
            locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
        });
        hands.setOptions({
            maxNumHands: 1,
            modelComplexity: 1,
            minDetectionConfidence: 0.6,
            minTrackingConfidence: 0.6
        });
        hands.onResults(onHandResults);
        cameraInstance = new Camera(videoElement, {
            onFrame: async () => {
                if (isWebcamActive) await hands.send({ image: videoElement });
            },
            width: 640,
            height: 480
        });
        cameraInstance.start()
            .then(() => {
                cameraInitialized = true;
                isWebcamActive = true;
                hideCameraError();
                console.log('📸 背景視訊鏡頭已順利開啟，手勢偵測就緒！');
            })
            .catch(err => {
                console.warn('無法啟動相機：', err);
                let message = '';
                const errName = err.name || '';
                if (errName === 'NotFoundError' || errName === 'DevicesNotFoundError') {
                    message = '找不到相機設備。請確認電腦有接相機，或允許瀏覽器存取相機後重新整理頁面。\n沒有相機也沒關係，可以改用滑鼠在窗戶上擦拭，用點擊選項作答。';
                } else if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
                    message = '相機權限被拒絕。請點擊網址列左邊的鎖頭圖示，允許相機存取後重新整理頁面。\n沒有相機也沒關係，可以改用滑鼠在窗戶上擦拭，用點擊選項作答。';
                } else {
                    message = `相機無法啟動（${errName || err.message || '未知錯誤'}）。\n沒有相機也沒關係，可以改用滑鼠在窗戶上擦拭，用點擊選項作答。`;
                }
                showCameraError(message);
            });
    }

    function onHandResults(results) {
        try {
            if (!isWebcamActive) {
                gesturePointersContainer.innerHTML = '';
                return;
            }
            gesturePointersContainer.innerHTML = '';
            if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
                const landmarks    = results.multiHandLandmarks[0];
                const indexFingerTip = landmarks[8];
                const thumbTip = landmarks[4];
                if (!indexFingerTip) return;
                const rect    = canvas.getBoundingClientRect();
                const localX = (1 - indexFingerTip.x) * rect.width;
                const localY = indexFingerTip.y * rect.height;
                const viewportX = rect.left + localX;
                const viewportY = rect.top + localY;
                const canvasX = (1 - indexFingerTip.x) * canvas.width;
                const canvasY = indexFingerTip.y * canvas.height;
                if (gameState === 'wiping') {
                    if (gestureLastX !== null && gestureLastY !== null) {
                        wipeContinuousPath(gestureLastX, gestureLastY, canvasX, canvasY);
                    } else {
                        wipeSingleSpot(canvasX, canvasY);
                    }
                    gestureLastX = canvasX;
                    gestureLastY = canvasY;
                    registerWipeAction();
                    checkClearedPercentage();
                    maybeForceCountdownFallback();
                    createVisualPointer(localX, localY);
                } else if (gameState === 'question') {
                    gestureLastX = null;
                    gestureLastY = null;
                    fingerPoints.push({
                        indexTip: { x: indexFingerTip.x, y: indexFingerTip.y },
                        thumbTip: { x: thumbTip.x, y: thumbTip.y },
                        time: Date.now()
                    });
                    if (fingerPoints.length > 5) fingerPoints.shift();
                    detectFistGesture(landmarks, indexFingerTip, thumbTip);
                    highlightButtonByGesture(viewportX, viewportY);
                    createVisualPointer(localX, localY);
                } else {
                    gestureLastX = null;
                    gestureLastY = null;
                }
            } else {
                gestureLastX = null;
                gestureLastY = null;
                if (currentHighlightBtn) {
                    currentHighlightBtn.classList.remove('gesture-hover');
                    currentHighlightBtn = null;
                }
            }
        } catch (error) {
            console.error('⚠️ 手勢背景處理發生容錯異常:', error);
            gestureLastX = null;
            gestureLastY = null;
        }
    }

    function detectFistGesture(landmarks, indexTip, thumbTip) {
        if (gameState !== 'question') return;
        const indexThumbDist = Math.sqrt(
            Math.pow(indexTip.x - thumbTip.x, 2) +
            Math.pow(indexTip.y - thumbTip.y, 2)
        );
        if (indexThumbDist < 0.1) {
            const now = Date.now();
            if (now - lastSelectionTime > 800) {
                if (currentHighlightBtn) {
                    console.log('✋ 握拳手勢偵測 - 選擇：', currentHighlightBtn.textContent);
                    currentHighlightBtn.click();
                    lastSelectionTime = now;
                }
            }
        }
    }

    function highlightButtonByGesture(screenX, screenY) {
        if (gameState !== 'question') return;
        let targetBtn = null;
        const now = Date.now();
        qaButtons.forEach(btn => {
            const rect = btn.getBoundingClientRect();
            const margin = 30;
            if (screenX >= rect.left - margin && screenX <= rect.right + margin &&
                screenY >= rect.top - margin && screenY <= rect.bottom + margin) {
                targetBtn = btn;
            }
        });
        if (targetBtn !== currentHighlightBtn) {
            if (currentHighlightBtn) {
                currentHighlightBtn.classList.remove('gesture-hover');
            }
            if (targetBtn) {
                targetBtn.classList.add('gesture-hover');
                hoveredButtonTime = now;
                console.log('👆 指向按鈕：' + targetBtn.textContent + ' (1.2秒後自動選擇)');
            }
            currentHighlightBtn = targetBtn;
        } else if (targetBtn && now - hoveredButtonTime > 1200) {
            if (now - lastSelectionTime > 800) {
                console.log('⏱️ 超時自動選擇：' + targetBtn.textContent);
                targetBtn.click();
                lastSelectionTime = now;
                hoveredButtonTime = now;
            }
        }
    }

    function createVisualPointer(x, y) {
        if (gameState !== 'wiping' && gameState !== 'question') return;
        const pointer = document.createElement('div');
        pointer.className = 'finger-pointer';
        if (GAME_CONFIG.WIPE_SHAPE === 'square') pointer.style.borderRadius = '4px';
        const indicatorSize = gameState === 'wiping'
            ? Math.max(20, GAME_CONFIG.WIPE_SIZE * 0.25)
            : 20;
        pointer.style.width  = `${indicatorSize}px`;
        pointer.style.height = `${indicatorSize}px`;
        pointer.style.left   = `${x}px`;
        pointer.style.top    = `${y}px`;
        gesturePointersContainer.appendChild(pointer);
    }
});
