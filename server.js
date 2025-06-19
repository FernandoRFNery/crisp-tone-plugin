/**
 * Tone Detection & Profanity Alert Server (Crisp Plugin - Multi-Tenant Edition)
 * -----------------------------------------------------------------------------
 * This version supports multi-tenancy, storing separate configurations for each
 * Crisp website_id.
 *
 * - Configurations are stored in the `config/` directory, with one JSON file per website_id.
 * - This avoids a database and ensures settings are not shared between different users.
 *
 * Endpoints:
 * - GET  /plugin-config?website_id=<ID>   (returns config for a specific website)
 * - POST /plugin-config?website_id=<ID>   (saves config for a specific website)
 * - POST /webhook                          (Crisp webhook, uses website_id from payload to get config)
 * - GET  /health                           (health check)
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

// Configure helmet to allow Crisp's domain(s) to embed content
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

// --- ⬇️ CONFIGURATION (Per-website, persisted to files) ⬇️ ---

const CONFIG_DIR = path.join(__dirname, "config");
// Ensure the configuration directory exists
if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR);
    console.log(`[${new Date().toISOString()}] Created configuration directory at: ${CONFIG_DIR}`);
}

const CRISP_IDENTIFIER = process.env.CRISP_IDENTIFIER;
const CRISP_KEY = process.env.CRISP_KEY;
const SLACK_WEBHOOK_URL_ENV = process.env.SLACK_WEBHOOK_URL;
const CRISP_WEBSITE_ID_GLOBAL = process.env.CRISP_WEBSITE_ID; // Kept for reference or single-tenant fallback

if (!CRISP_IDENTIFIER || !CRISP_KEY) {
    console.error("Missing required environment variables. Please set CRISP_IDENTIFIER and CRISP_KEY.");
    process.exit(1);
}

// Function to get the file path for a given website's config
function getConfigFilePath(websiteId) {
    // Basic validation to prevent path traversal
    if (!websiteId || !/^[a-zA-Z0-9-]{36}$/.test(websiteId)) {
        return null;
    }
    return path.join(CONFIG_DIR, `${websiteId}.json`);
}

// Function to load a website's config from a file or initialize defaults
function loadPluginConfig(websiteId) {
    const configPath = getConfigFilePath(websiteId);
    if (!configPath) {
        console.error(`[${new Date().toISOString()}] Invalid websiteId provided: ${websiteId}`);
        return null; // Return null for invalid IDs
    }

    try {
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf8');
            console.log(`[${new Date().toISOString()}] Loaded plugin config for website: ${websiteId}`);
            return JSON.parse(data);
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error reading config file for ${websiteId}, using defaults:`, error);
    }

    // Default values for a new configuration
    return {
        tagToApply: "profanity-alert",
        negativeThreshold: -0.5,
        slackEnabled: false,
        slackWebhookUrl: SLACK_WEBHOOK_URL_ENV || "", // Use env var for initial load if available
        highlightProfanity: true
    };
}

// Function to save a website's config to a file
function savePluginConfig(websiteId, config) {
    const configPath = getConfigFilePath(websiteId);
     if (!configPath) {
        console.error(`[${new Date().toISOString()}] Cannot save config due to invalid websiteId: ${websiteId}`);
        return false;
    }
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        console.log(`[${new Date().toISOString()}] Saved plugin config for website: ${websiteId}`);
        return true;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error writing config file for ${websiteId}:`, error);
        return false;
    }
}

// --- Plugin Config API (for Crisp plugin UI) ---

/**
 * GET /plugin-config?website_id=<ID>
 * Returns the current plugin config for the specified website.
 */
app.get('/plugin-config', (req, res) => {
    const { website_id } = req.query;
    if (!website_id) {
        return res.status(400).json({ error: "Missing website_id query parameter." });
    }

    const config = loadPluginConfig(website_id);
    if (!config) {
         return res.status(400).json({ error: "Invalid website_id provided." });
    }
    
    res.status(200).json(config);
});

/**
 * POST /plugin-config?website_id=<ID>
 * Saves the plugin config for the specified website.
 */
app.post('/plugin-config', (req, res) => {
    const { website_id } = req.query;
    if (!website_id) {
        return res.status(400).json({ ok: false, error: "Missing website_id query parameter." });
    }

    const currentConfig = loadPluginConfig(website_id);
    if (!currentConfig) {
        return res.status(400).json({ ok: false, error: "Invalid website_id provided." });
    }

    const { tagToApply, negativeThreshold, slackEnabled, slackWebhookUrl, highlightProfanity } = req.body || {};
    let errors = [];

    // Create a new config object to update, starting from the current one
    const newConfig = { ...currentConfig };

    // Validate and update fields
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

    if (savePluginConfig(website_id, newConfig)) {
        return res.status(200).json({ ok: true, ...newConfig });
    } else {
        return res.status(500).json({ ok: false, error: "Failed to save configuration." });
    }
});


// --- ⬆️ END CONFIGURATION ⬆️ ---

// Serve static plugin files (including settings.html)
app.use(express.static(path.join(__dirname, "public")));

// Serve plugin.json (for Crisp discovery)
app.get("/plugin.json", (req, res) => {
    res.sendFile(path.join(__dirname, "plugin.json"));
});

// Serve the HTML settings page (if requested directly, though typically handled by static middleware)
app.get("/settings.html", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "settings.html"));
});


function getAuth() {
    return Buffer.from(`${CRISP_IDENTIFIER}:${CRISP_KEY}`).toString('base64');
}

// ... The rest of your utility functions (getAllProfanitiesInMessage, postPrivateNoteToCrisp, etc.) remain largely the same ...
// Small adjustments are needed for highlightProfanity and sendSlackNotification to accept config.

function getAllProfanitiesInMessage(message) {
    if (typeof message !== 'string' || !message.length) return [];
    if (!profanity || !Array.isArray(profanity.list) || profanity.list.length === 0) return [];
    const profaneList = profanity.list.filter(w => typeof w === 'string' && w.length > 0).map(w => w.toLowerCase());
    if (!Array.isArray(profaneList) || profaneList.length === 0) return [];
    const tokens = message.match(/\b\w+\b/g) || [];
    const found = [];
    tokens.forEach(token => {
        if (typeof token === 'string' && profaneList.includes(token.toLowerCase())) {
            found.push(token);
        }
    });
    return found;
}

function highlightProfanity(message, config) { // Accepts config
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

function getSentimentSummary(score) {
    if (score <= -1) return "Very Negative";
    if (score < 0) return "Negative";
    if (score === 0) return "Neutral";
    if (score < 1) return "Positive";
    return "Very Positive";
}

async function postPrivateNoteToCrisp(websiteId, sessionId, noteContent) {
    const url = `https://api.crisp.chat/v1/website/${websiteId}/conversation/${sessionId}/message`;
    const payload = { type: "note", from: "operator", origin: "chat", content: noteContent };
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${getAuth()}`, 'X-Crisp-Tier': 'plugin' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            console.error(`[${new Date().toISOString()}] Failed to post note to Crisp for ${websiteId}:`, response.status, await response.text());
        } else {
            console.log(`[${new Date().toISOString()}] Private note posted to Crisp for ${websiteId}.`);
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error posting note to Crisp for ${websiteId}:`, error);
    }
}

async function tagCrispConversation(websiteId, sessionId, tag) {
    const metaUrl = `https://api.crisp.chat/v1/website/${websiteId}/conversation/${sessionId}/meta`;
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Basic ${getAuth()}`, 'X-Crisp-Tier': 'plugin' };
    try {
        const metaResponse = await fetch(metaUrl, { headers });
        if (!metaResponse.ok) {
            console.error(`[${new Date().toISOString()}] Failed to get conversation metadata for ${websiteId}:`, metaResponse.status, await metaResponse.text());
            return;
        }
        const metadata = await metaResponse.json();
        const existingSegments = metadata?.data?.segments?.map(s => (typeof s === 'string' ? s : s.name)) || [];
        if (existingSegments.map(t => t.toLowerCase()).includes(tag.toLowerCase())) {
            console.log(`[${new Date().toISOString()}] Tag "${tag}" already exists on ${sessionId}. Skipping.`);
            return;
        }
        const updatedSegments = [...existingSegments, tag];
        const patchResponse = await fetch(metaUrl, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ segments: updatedSegments })
        });
        if (!patchResponse.ok) {
            console.error(`[${new Date().toISOString()}] Failed to tag conversation ${sessionId}:`, patchResponse.status, await patchResponse.text());
        } else {
            console.log(`[${new Date().toISOString()}] Tagged conversation ${sessionId} with "${tag}".`);
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error tagging conversation ${sessionId}:`, error);
    }
}

async function sendSlackNotification(alertNote, websiteId, sessionId, alertDetails = {}, config) { // Accepts config
    if (!config.slackEnabled || !config.slackWebhookUrl) {
        console.log(`[${new Date().toISOString()}] Slack alerts disabled for ${websiteId}. Skipping.`);
        return;
    }
    const crispLink = `https://app.crisp.chat/website/${websiteId}/inbox/${sessionId}/`;
    const payload = {
        text: "Negative & Profane Customer Message Detected",
        blocks: [ { type: "header", text: { type: "plain_text", text: "🚨 Profanity & Negative Tone Detected" } }, { type: "section", text: { type: "mrkdwn", text: alertNote.replace(/\*\*/g, '*') } }, { type: "actions", elements: [ { type: "button", text: { type: "plain_text", text: "View in Crisp" }, style: "primary", url: crispLink } ] } ]
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

/**
 * Process a user message using the config specific to their website_id.
 */
async function processMessage(data) {
    const { website_id, session_id, content, user_id, timestamp } = data;
    if (!website_id || !session_id || typeof content !== 'string') {
        console.warn(`[${new Date().toISOString()}] Invalid webhook data received.`);
        return;
    }

    // Load the configuration for this specific website
    const config = loadPluginConfig(website_id);
    if (!config) {
        console.error(`[${new Date().toISOString()}] Could not load configuration for website ${website_id}. Aborting processing.`);
        return;
    }

    try {
        if (profanity.exists(content)) {
            const analysis = sentiment.analyze(content);
            if (analysis.comparative < config.negativeThreshold) {
                console.log(`[${new Date().toISOString()}] Alert for ${website_id}: Negative sentiment (Score: ${analysis.comparative.toFixed(2)}).`);
                
                const uniqueProfaneWords = [...new Set(getAllProfanitiesInMessage(content))];
                const highlightedMessage = highlightProfanity(content, config); // Pass config
                const sentimentSummary = getSentimentSummary(analysis.comparative);

                const note = [
                    "**Profanity & Negative Tone Alert**",
                    `> ${highlightedMessage}`,
                    `*Sentiment Score:* ${analysis.comparative.toFixed(2)} (${sentimentSummary})`,
                ].join('\n');

                await Promise.allSettled([
                    postPrivateNoteToCrisp(website_id, session_id, note),
                    sendSlackNotification(note, website_id, session_id, {}, config), // Pass config
                    tagCrispConversation(website_id, session_id, config.tagToApply)
                ]);
            }
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error during message processing for ${website_id}:`, error);
    }
}

// Webhook endpoint
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    try {
        const { event, data } = req.body || {};
        if (event === 'message:send' && data?.from === 'user' && data?.type === 'text') {
            await processMessage(data);
        }
    } catch (err) {
        console.error(`[${new Date().toISOString()}] Error in /webhook handler:`, err);
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] Crisp Multi-Tenant Plugin Server running at http://localhost:${PORT}`);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`[${new Date().toISOString()}] Unhandled Rejection:`, reason);
});
process.on('uncaughtException', (err) => {
    console.error(`[${new Date().toISOString()}] Uncaught Exception:`, err);
    process.exit(1);
});
