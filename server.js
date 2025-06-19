/**
 * Tone Detection & Profanity Alert Server (Multi-Tenant Crisp Plugin)
 * -------------------------------------------------------------------
 * This version supports multiple tenants (Crisp websites) by storing
 * configuration on a per-website_id basis.
 *
 * Changes:
 * - Configuration is stored in a `data/` directory, with one JSON file per website_id.
 * - API endpoints are now /api/config/:website_id.
 * - The webhook processor loads the specific configuration for the incoming website_id.
 * - This prevents settings from one user from overwriting another's.
 *
 * Endpoints:
 * - GET  /plugin.json              (serves the plugin manifest)
 * - GET  /settings.html            (serves the plugin settings page)
 * - GET  /api/config/:website_id   (returns config for a specific website)
 * - POST /api/config/:website_id   (saves config for a specific website)
 * - POST /webhook                  (Crisp webhook, now multi-tenant aware)
 * - GET  /health                   (health check)
 */

require('dotenv').config();

const path = require("path");
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Profanity } = require('@2toad/profanity');
const Sentiment = require('sentiment');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 8080;
const profanity = new Profanity();
const sentiment = new Sentiment();

app.set('trust proxy', 1);

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://app.crisp.chat', 'https://marketplace.crisp.chat'],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://app.crisp.chat', 'https://marketplace.crisp.chat'],
            imgSrc: ["'self'", 'data:', 'https://app.crisp.chat', 'https://marketplace.crisp.chat'],
            connectSrc: ["'self'", 'https://app.crisp.chat', 'https://marketplace.crisp.chat'],
            frameAncestors: ["'self'", 'https://app.crisp.chat', 'https://marketplace.crisp.chat'],
        }
    }
}));

app.use(bodyParser.json());

const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
    console.log(`[${new Date().toISOString()}] Created data directory at: ${DATA_DIR}`);
}

function getConfigFilePath(websiteId) {
    const safeWebsiteId = path.basename(websiteId);
    if (!safeWebsiteId || safeWebsiteId === '.' || safeWebsiteId === '..') {
        throw new Error("Invalid website_id provided.");
    }
    return path.join(DATA_DIR, `${safeWebsiteId}.json`);
}

const CRISP_IDENTIFIER = process.env.CRISP_IDENTIFIER;
const CRISP_KEY = process.env.CRISP_KEY;

if (!CRISP_IDENTIFIER || !CRISP_KEY) {
    console.error("Missing required environment variables. Please set CRISP_IDENTIFIER and CRISP_KEY.");
    process.exit(1);
}

function loadPluginConfig(websiteId) {
    const filePath = getConfigFilePath(websiteId);
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            console.log(`[${new Date().toISOString()}] Loaded plugin config for website_id: ${websiteId}`);
            return JSON.parse(data);
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error reading config for ${websiteId}, using defaults:`, error);
    }
    return {
        tagToApply: "profanity-alert",
        negativeThreshold: 0,
        slackEnabled: false,
        slackWebhookUrl: "",
        highlightProfanity: true
    };
}

function savePluginConfig(websiteId, config) {
    const filePath = getConfigFilePath(websiteId);
    try {
        fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
        console.log(`[${new Date().toISOString()}] Saved plugin config for website_id: ${websiteId}`);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error writing config file for ${websiteId}:`, error);
    }
}

// --- Plugin Endpoints ---

// **FIXED**: Explicitly serve plugin files with corrected names.

// Serve plugin.json, which Crisp needs to identify the plugin.
app.get('/plugin.json', (req, res) => {
    // Make sure 'plugin.json' is in your project's root directory.
    res.sendFile(path.join(__dirname, 'plugin.json'));
});

// Serve the settings page. This path must match what you set in the Crisp Marketplace.
app.get('/settings.html', (req, res) => {
    // Make sure 'settings.html' is in your project's root directory.
    res.sendFile(path.join(__dirname, 'settings.html'));
});

// A fallback for /settings in case the URL was configured without the .html extension.
app.get('/settings', (req, res) => {
    res.sendFile(path.join(__dirname, 'settings.html'));
});


app.get('/api/config/:website_id', (req, res) => {
    try {
        const { website_id } = req.params;
        const config = loadPluginConfig(website_id);
        res.status(200).json(config);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error in GET /api/config:`, error);
        res.status(400).json({ ok: false, error: error.message });
    }
});

app.post('/api/config/:website_id', (req, res) => {
    try {
        const { website_id } = req.params;
        const currentConfig = loadPluginConfig(website_id);
        const { tagToApply, negativeThreshold, slackEnabled, slackWebhookUrl, highlightProfanity } = req.body || {};
        let errors = [];

        const newConfig = { ...currentConfig };

        if (typeof tagToApply === "string" && tagToApply.trim().length > 0) {
            newConfig.tagToApply = tagToApply.trim();
        } else if (typeof tagToApply !== "undefined") {
            errors.push("tagToApply must be a non-empty string.");
        }

        if (typeof negativeThreshold === "number" && isFinite(negativeThreshold)) {
            newConfig.negativeThreshold = negativeThreshold;
        } else if (typeof negativeThreshold !== "undefined") {
            errors.push("negativeThreshold must be a number.");
        }

        if (typeof slackEnabled === "boolean") {
            newConfig.slackEnabled = slackEnabled;
        } else if (typeof slackEnabled !== "undefined") {
            errors.push("slackEnabled must be a boolean.");
        }

        if (typeof slackWebhookUrl === "string") {
            newConfig.slackWebhookUrl = slackWebhookUrl.trim();
        } else if (typeof slackWebhookUrl !== "undefined") {
            errors.push("slackWebhookUrl must be a string.");
        }

        if (typeof highlightProfanity === "boolean") {
            newConfig.highlightProfanity = highlightProfanity;
        } else if (typeof highlightProfanity !== "undefined") {
            errors.push("highlightProfanity must be a boolean.");
        }

        if (errors.length > 0) {
            return res.status(400).json({ ok: false, errors });
        }

        savePluginConfig(website_id, newConfig);
        return res.status(200).json({ ok: true, ...newConfig });

    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error in POST /api/config:`, error);
        res.status(400).json({ ok: false, error: error.message });
    }
});

function getAuth() {
    return Buffer.from(`${CRISP_IDENTIFIER}:${CRISP_KEY}`).toString('base64');
}

function highlightProfanity(message, config) {
    if (!config.highlightProfanity) {
        return message;
    }
    const profaneWords = getAllProfanitiesInMessage(message);
    if (!Array.isArray(profaneWords) || profaneWords.length === 0) return message;
    const uniqueProfaneWords = [...new Set(profaneWords)];
    let highlighted = message;
    uniqueProfaneWords.forEach(word => {
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
        highlighted = highlighted.replace(regex, match => `**${match}**`);
    });
    return highlighted;
}

function getAllProfanitiesInMessage(message) {
    if (typeof message !== 'string' || !message.length) return [];
    const profaneList = profanity.list.map(w => String(w).toLowerCase());
    const tokens = message.match(/\b\w+\b/g) || [];
    return tokens.filter(token => profaneList.includes(token.toLowerCase()));
}

function getSentimentSummary(score) {
    if (score <= -1) return "Very Negative";
    if (score < 0) return "Negative";
    if (score === 0) return "Neutral";
    if (score < 1) return "Positive";
    return "Very Positive";
}

async function sendSlackNotification(alertNote, sessionId, websiteId, config, alertDetails = {}) {
    if (!config.slackEnabled || !config.slackWebhookUrl) {
        console.log(`[${new Date().toISOString()}] Slack alerts disabled or Webhook URL not configured for ${websiteId}.`);
        return;
    }
    const crispLink = `https://app.crisp.chat/website/${websiteId}/inbox/${sessionId}/`;
    const { sentimentScore, sentimentSummary, profaneWords, messageTimestamp, userId } = alertDetails;
    const contextFields = [];
    if (typeof sentimentScore === "number") {
        contextFields.push({ type: "mrkdwn", text: `*Sentiment Score:* ${sentimentScore.toFixed(2)} (${sentimentSummary || getSentimentSummary(sentimentScore)})` });
    }
    if (profaneWords && profaneWords.length) {
        contextFields.push({ type: "mrkdwn", text: `*Profane Words:* ${profaneWords.map(w => `\`${w}\``).join(', ')}` });
    }
    const payload = {
        text: "Negative & Profane Customer Message Detected",
        blocks: [
            { type: "header", text: { type: "plain_text", text: "🚨 Profanity & Negative Tone Detected", emoji: true } },
            { type: "section", text: { type: "mrkdwn", text: alertNote.replace(/\*\*/g, '*') } },
            ...(contextFields.length ? [{ type: "context", elements: contextFields }] : []),
            { type: "actions", elements: [ { type: "button", text: { type: "plain_text", text: "View in Crisp", emoji: true }, style: "primary", url: crispLink } ] }
        ]
    };
     try {
        const response = await fetch(config.slackWebhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            console.error(`[${new Date().toISOString()}] Failed to send Slack notification for ${websiteId}:`, response.status, await response.text());
        } else {
            console.log(`[${new Date().toISOString()}] Slack notification sent for ${websiteId}.`);
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error sending Slack notification for ${websiteId}:`, error);
    }
}

async function postPrivateNoteToCrisp(websiteId, sessionId, noteContent) {
    const url = `https://api.crisp.chat/v1/website/${websiteId}/conversation/${sessionId}/message`;
    const payload = { type: "note", from: "operator", origin: "chat", content: noteContent };
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${getAuth()}`,
                'X-Crisp-Tier': 'plugin'
            },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            console.error(`[${new Date().toISOString()}] Failed to post note to Crisp:`, response.status, await response.text());
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error posting note to Crisp:`, error);
    }
}
async function tagCrispConversation(websiteId, sessionId, tag) {
    const metaUrl = `https://api.crisp.chat/v1/website/${websiteId}/conversation/${sessionId}/meta`;
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Basic ${getAuth()}`, 'X-Crisp-Tier': 'plugin' };
    try {
        const metaResponse = await fetch(metaUrl, { headers });
        if (!metaResponse.ok) return;
        const metadata = await metaResponse.json();
        const existingSegments = metadata?.data?.segments || [];
        if (existingSegments.includes(tag)) return;
        const updatedSegments = [...existingSegments, tag];
        await fetch(metaUrl, { method: 'PATCH', headers, body: JSON.stringify({ segments: updatedSegments }) });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error tagging conversation:`, error);
    }
}

async function processMessage(data) {
    try {
        const { website_id, session_id, content, user_id, timestamp } = data;
        if (!website_id || !session_id || typeof content !== 'string') {
            return;
        }

        const config = loadPluginConfig(website_id);
        const normalizedContent = content.replace(/[^a-zA-Z0-9\s]/g, '');

        if (profanity.exists(content) || profanity.exists(normalizedContent)) {
            const analysis = sentiment.analyze(content);

            if (analysis.comparative < config.negativeThreshold) {
                console.log(`[${new Date().toISOString()}] Negative sentiment for ${website_id} (Score: ${analysis.comparative.toFixed(2)}). Triggering alert.`);
                const profaneWords = getAllProfanitiesInMessage(content);
                const uniqueProfaneWords = [...new Set(profaneWords)];
                
                const highlightedMessage = highlightProfanity(content, config);
                const sentimentSummary = getSentimentSummary(analysis.comparative);

                const note = [
                    "**Profanity & Negative Tone Alert**",
                    `> ${highlightedMessage}`,
                    "",
                    `*Sentiment Score:* ${analysis.comparative.toFixed(2)} (${sentimentSummary})`,
                    uniqueProfaneWords.length ? `*Profane Words Detected:* ${uniqueProfaneWords.map(w => `\`${w}\``).join(', ')}` : "",
                ].filter(Boolean).join('\n');

                await Promise.allSettled([
                    postPrivateNoteToCrisp(website_id, session_id, note),
                    sendSlackNotification(note, session_id, website_id, config, {
                        sentimentScore: analysis.comparative,
                        sentimentSummary,
                        profaneWords: uniqueProfaneWords,
                    }),
                    tagCrispConversation(website_id, session_id, config.tagToApply)
                ]);
            }
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error during message processing:`, error);
    }
}

// Webhook endpoint
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    try {
        const { event, data } = req.body || {};
        if (event === 'message:send' && data && data.from === 'user' && data.type === 'text') {
            await processMessage(data);
        }
    } catch (err) {
        console.error(`[${new Date().toISOString()}] Error in /webhook handler:`, err);
    }
});

// Health check and root endpoints
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
    res.status(200).send('<h1>Crisp Tone & Profanity Detector Plugin</h1><p>Server is running. Health check available at <a href="/health">/health</a>.</p>');
});

// Start server
app.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] Crisp Multi-Tenant Plugin running at http://localhost:${PORT}`);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`[${new Date().toISOString()}] Unhandled Rejection:`, reason);
});
process.on('uncaughtException', (err) => {
    console.error(`[${new Date().toISOString()}] Uncaught Exception:`, err);
    process.exit(1);
});
