"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const pino_1 = __importDefault(require("pino"));
const zod_1 = require("zod");
const hybrid_1 = require("./search/hybrid");
const logger = (0, pino_1.default)({ transport: { target: 'pino-pretty' } });
const app = (0, express_1.default)();
app.use(express_1.default.json());
app.get('/health', (_req, res) => res.json({ ok: true }));
app.post('/search', async (req, res) => {
    const bodySchema = zod_1.z.object({ q: zod_1.z.string().min(1) });
    const parse = bodySchema.safeParse(req.body);
    if (!parse.success)
        return res.status(400).json({ error: 'invalid body' });
    const t0 = Date.now();
    try {
        const result = await (0, hybrid_1.hybridSearch)(parse.data.q);
        res.json({ took_ms: Date.now() - t0, ...result });
    }
    catch (e) {
        logger.error(e);
        // 失敗時も API を死なせない（モック返却）
        res.json({
            took_ms: Date.now() - t0,
            items: [
                { id: 'mock-1', text: '（モック）返品ポリシー', score: 0.9, source: 'es' },
                { id: 'mock-2', text: '（モック）送料の考え方', score: 0.8, source: 'pg' }
            ],
            ms: 0,
            note: 'ES/PG未接続のためモック応答'
        });
    }
});
const port = Number(process.env.PORT || 3000);
// 追加: 起動時に接続先スナップショットを出す
logger.info({ ES_URL: process.env.ES_URL, DATABASE_URL: process.env.DATABASE_URL }, 'env snapshot');
app.listen(port, () => {
    logger.info(`server listening on :${port}`);
});
