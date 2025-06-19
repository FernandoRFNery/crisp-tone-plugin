/**
 * Tone & Toxicity Detection Server (Crisp Plugin - Self-Hosted AI Model)
 * -----------------------------------------------------------------------
 * This version uses a free, locally-hosted and QUANTIZED machine learning 
 * model for memory-efficient, private, and cost-free toxicity detection.
 */

// Use import for all modules
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import express from 'express';
import bodyParser from 'body-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import fetch from 'node-fetch';
import { pipeline } from '@xenova/transformers';

// Recreate __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// --- Singleton Class to manage the AI model ---
// This ensures the model is loaded only once when the server starts.
class ToxicityPipeline {
    static task = 'text-classification';
    static model = 'Xenova/toxic-bert';
    static instance = null;

    static async getInstance(progress_callback = null) {
        if (this.instance === null) {
            console.log('Loading quantized (memory-efficient) toxicity detection model...');
            const start = Date.now();
            // The pipeline function is now imported, so we don't need to await the import itself.
            this.instance = pipeline(this.task, this.model, { 
                quantized: true, // This enables the memory-saving version of the model.
                progress_callback 
            });
            this.instance.then(() => {
                 console.log(`Model loaded successfully in ${(Date.now() - start) / 1000}s`);
            });
        }
        return this.instance;
    }
}

const app = express();
const PORT = process.env.PORT || 8080;

app.set('trust proxy', 1);

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", 'https://app.crisp.chat', 'https://marketplace.crisp.chat'],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://app.crisp.chat', 'https://marketplace.crisp.chat'],
            frameAncestors: ["'self'", 'https://app.crisp.chat', 'https://marketplace.crisp.chat'],
        }
    },
    xFrameOptions: false,
}));

app.use(bodyParser.json());

const limiter = rateLimit({ windowMs: 60 * 1000, max: 100 });
app.use(limiter);

// --- ⬇️ CONFIGURATION & API KEYS ⬇️ ---

const CONFIG_DIR = path.join(__dirname, "config");
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR);

const CRISP_IDENTIFIER = process.env.CRISP_IDENTIFIER;
const CRISP_KEY = process.env.CRISP_KEY;

if (!CRISP_IDENTIFIER || !CRISP_KEY) {
    console.error("Missing Crisp credentials in environment variables.");
    process.exit(1);
}

// --- Configuration Management ---

function getConfigFilePath(websiteId) {
    if (!websiteId || !/^[a-zA-Z0-9-]{36}$/.test(websiteId)) return null;
    return path.join(CONFIG_DIR, `${websiteId}.json`);
}

function loadPluginConfig(websiteId) {
    const configPath = getConfigFilePath(websiteId);
    if (!configPath) return null;
    if (fs.existsSync(configPath)) {
        try {
            return JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (error) {
            console.error(`Error reading config for ${websiteId}:`, error);
        }
    }
    // Default config is now simpler
    return {
        tagToApply: "toxic-alert",
        detectionEnabled: true, // Simple on/off switch
        slackEnabled: false,
        slackWebhookUrl: "",
    };
}

function savePluginConfig(websiteId, config) {
    const configPath = getConfigFilePath(websiteId);
    if (!configPath) return false;
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error(`Error writing config for ${websiteId}:`, error);
        return false;
    }
}

// --- API Endpoints ---

app.get('/plugin-config', (req, res) => {
    const { website_id } = req.query;
    if (!website_id) return res.status(400).json({ error: "Missing website_id" });
    const config = loadPluginConfig(website_id);
    if (!config) return res.status(400).json({ error: "Invalid website_id" });
    res.status(200).json(config);
});

app.post('/plugin-config', (req, res) => {
    const { website_id } = req.query;
    if (!website_id) return res.status(400).json({ ok: false, error: "Missing website_id" });

    const currentConfig = loadPluginConfig(website_id);
    const { tagToApply, detectionEnabled, slackEnabled, slackWebhookUrl } = req.body || {};
    
    // Update config with new values
    if (tagToApply) currentConfig.tagToApply = tagToApply;
    if (typeof detectionEnabled === 'boolean') currentConfig.detectionEnabled = detectionEnabled;
    if (typeof slackEnabled === 'boolean') currentConfig.slackEnabled = slackEnabled;
    if (typeof slackWebhookUrl === 'string') currentConfig.slackWebhookUrl = slackWebhookUrl;
    
    if (savePluginConfig(website_id, currentConfig)) {
        res.status(200).json({ ok: true, ...currentConfig });
    } else {
        res.status(500).json({ ok: false, error: "Failed to save configuration." });
    }
});

// --- UPDATED: Main Message Processing Logic ---

/**
 * Process a user message using the local AI model.
 */
async function processMessage(data) {
    const { website_id, session_id, content } = data;
    if (!website_id || !session_id || typeof content !== 'string' || content.trim().length === 0) return;

    const config = loadPluginConfig(website_id);
    if (!config || !config.detectionEnabled) return;

    try {
        // Get the classifier instance
        const classifier = await ToxicityPipeline.getInstance();
        // Analyze the message
        const results = await classifier(content);

        // Find the 'toxic' label in the results
        const toxicResult = results.find(item => item.label === 'toxic');

        if (toxicResult && toxicResult.score > 0.8) { // You can keep a hardcoded threshold for confidence
            console.log(`[${new Date().toISOString()}] High toxicity detected for ${website_id} (Score: ${toxicResult.score.toFixed(2)})`);

            const note = `**Toxicity Alert**\n\nA message was flagged by the local AI model.\n\n> ${content}\n\n*Toxicity Score:* ${(toxicResult.score * 100).toFixed(1)}%`;

            await Promise.allSettled([
                postPrivateNoteToCrisp(website_id, session_id, note),
                sendSlackNotification(note, website_id, session_id, config),
                tagCrispConversation(website_id, session_id, config.tagToApply)
            ]);
        }
    } catch (error) {
        console.error("Error during local AI analysis:", error);
    }
}


// --- Crisp & Slack Utility Functions (unchanged) ---

function getAuth() {
    return Buffer.from(`${CRISP_IDENTIFIER}:${CRISP_KEY}`).toString('base64');
}

async function postPrivateNoteToCrisp(websiteId, sessionId, noteContent) {
    const url = `https://api.crisp.chat/v1/website/${websiteId}/conversation/${sessionId}/message`;
    const payload = { type: "note", content: noteContent, from: "operator", origin: "chat" };
    await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${getAuth()}`, 'X-Crisp-Tier': 'plugin' },
        body: JSON.stringify(payload)
    }).catch(err => console.error("Error posting to Crisp:", err));
}

async function tagCrispConversation(websiteId, sessionId, tag) {
    const url = `https://api.crisp.chat/v1/website/${websiteId}/conversation/${sessionId}/meta`;
    const body = { data: { segments: [tag] } }; // Use the data object for segments
    await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${getAuth()}`, 'X-Crisp-Tier': 'plugin' },
        body: JSON.stringify(body)
    }).catch(err => console.error("Error tagging in Crisp:", err));
}

async function sendSlackNotification(alertNote, websiteId, sessionId, config) {
    if (!config.slackEnabled || !config.slackWebhookUrl) return;
    const crispLink = `https://app.crisp.chat/website/${websiteId}/inbox/${sessionId}/`;
    const payload = {
        blocks: [
            { type: "header", text: { type: "plain_text", text: "🚨 Toxicity Alert" } },
            { type: "section", text: { type: "mrkdwn", text: alertNote } },
            { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "View in Crisp" }, style: "primary", url: crispLink }] }
        ]
    };
    await fetch(config.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).catch(err => console.error("Error sending to Slack:", err));
}

// --- Server Setup ---

// Pre-load the model on server start to make subsequent requests fast.
ToxicityPipeline.getInstance().then(() => {
    app.use(express.static(path.join(__dirname, "public")));
    app.get("/plugin.json", (req, res) => res.sendFile(path.join(__dirname, "plugin.json")));
    app.get("/settings", (req, res) => res.sendFile(path.join(__dirname, "public", "settings.html")));
    app.post('/webhook', (req, res) => {
        res.sendStatus(200);
        if (req.body?.event === 'message:send' && req.body.data?.from === 'user') {
            processMessage(req.body.data);
        }
    });

    app.listen(PORT, () => console.log(`Crisp Toxicity Plugin with local AI running on port ${PORT}`));
}).catch(err => {
    console.error("Failed to load the AI model. The app will not start.", err);
    process.exit(1);
});
