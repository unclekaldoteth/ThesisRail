import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import http from 'http';
import { alphaRouter } from './api/alpha';
import { campaignRouter } from './api/campaigns';
import { startOnchainReconciler, stopOnchainReconciler } from './onchain/reconciler';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3001', 10);

export function createApp(): express.Express {
    const app = express();

    app.use(cors({ origin: '*' }));
    app.use(express.json());

    // Health check
    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', service: 'thesis-rail-api', timestamp: new Date().toISOString() });
    });

    // API routes
    app.use('/v1/alpha', alphaRouter);
    app.use('/v1/campaigns', campaignRouter);

    return app;
}

export function startServer(port = PORT): http.Server {
    const app = createApp();
    const server = http.createServer(app);
    server.listen(port, () => {
        startOnchainReconciler();
        console.log(`[ThesisRail API] Running on http://localhost:${port}`);
        console.log('[ThesisRail API] x402-enforced: GET /v1/alpha/cards');
        console.log('[ThesisRail API] Free: POST /v1/campaigns/convert');
    });

    const shutdown = () => {
        stopOnchainReconciler();
        server.close();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    return server;
}

const app = createApp();

if (require.main === module) {
    startServer();
}

export default app;
