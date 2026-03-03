import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import http from 'http';
import { alphaRouter } from './api/alpha';
import { campaignRouter } from './api/campaigns';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

app.use(cors({ origin: '*' }));
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'thesis-rail-api', timestamp: new Date().toISOString() });
});

// API routes
app.use('/v1/alpha', alphaRouter);
app.use('/v1/campaigns', campaignRouter);

// Create HTTP server and keep process alive
const server = http.createServer(app);
server.listen(PORT, () => {
    console.log(`[ThesisRail API] Running on http://localhost:${PORT}`);
    console.log(`[ThesisRail API] x402-enforced: GET /v1/alpha/cards`);
    console.log(`[ThesisRail API] Free: POST /v1/campaigns/convert`);
});

export default app;
