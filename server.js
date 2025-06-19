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

// **NEW**: Define a directory for storing per-website configuration files.
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
    console.log(`[${new Date().toISOString()}] Created data directory at: ${DATA_DIR}`);
}

// **MODIFIED**: Helper function to get the config file path for a specific website.
function getConfigFilePath(websiteId) {
    // Basic sanitization to prevent directory traversal attacks
    const safeWebsiteId = path.basename(websiteId);
    if (!safeWebsiteId || safeWebsiteId === '.' || safeWebsiteId === '..') {
        throw new Error("Invalid website_id provided.");
    }
    return path.join(DATA_DIR, `${safeWebsiteId}.json`);
}

// --- ⬇️ CONFIGURATION (Per-Website) ⬇️ ---

const CRISP_IDENTIFIER = process.env.CRISP_IDENTIFIER;
const CRISP_KEY = process.env.CRISP_KEY;
const SLACK_WEBHOOK_URL_ENV = process.env.SLACK_WEBHOOK_URL;
const CRISP_WEBSITE_ID = process.env.CRISP_WEBSITE_ID; // Note: This is now less relevant for multi-tenant logic but needed for auth.

if (!CRISP_IDENTIFIER || !CRISP_KEY) {
    console.error("Missing required environment variables. Please set CRISP_IDENTIFIER and CRISP_KEY.");
    process.exit(1);
}

// **MODIFIED**: Function to load a specific website's config or return defaults.
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
    // Default values for a new or unconfigured website
    return {
        tagToApply: "profanity-alert",
        negativeThreshold: 0,
        slackEnabled: false,
        slackWebhookUrl: "",
        highlightProfanity: true
    };
}

// **MODIFIED**: Function to save a specific website's config.
function savePluginConfig(websiteId, config) {
    const filePath = getConfigFilePath(websiteId);
    try {
        fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
        console.log(`[${new Date().toISOString()}] Saved plugin config for website_id: ${websiteId}`);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error writing config file for ${websiteId}:`, error);
    }
}

// --- Plugin Config API (Multi-Tenant) ---

/**
 * GET /api/config/:website_id
 * Returns the plugin config for a specific website.
 */
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

/**
 * POST /api/config/:website_id
 * Saves the plugin config for a specific website.
 */
app.post('/api/config/:website_id', (req, res) => {
    try {
        const { website_id } = req.params;
        const currentConfig = loadPluginConfig(website_id);
        const { tagToApply, negativeThreshold, slackEnabled, slackWebhookUrl, highlightProfanity } = req.body || {};
        let errors = [];

        // Validate and build the new config
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

// --- ⬆️ END CONFIGURATION ⬆️ ---

// Serve static plugin files
app.use(express.static(__dirname));


function getAuth() {
    return Buffer.from(`${CRISP_IDENTIFIER}:${CRISP_KEY}`).toString('base64');
}

// **MODIFIED**: Highlighting now depends on the config passed to it.
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

// (getAllProfanitiesInMessage and getSentimentSummary remain unchanged)
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

// **MODIFIED**: Slack notifications now depend on the config passed to it.
async function sendSlackNotification(alertNote, sessionId, websiteId, config, alertDetails = {}) {
    if (!config.slackEnabled || !config.slackWebhookUrl) {
        console.log(`[${new Date().toISOString()}] Slack alerts disabled or Webhook URL not configured for ${websiteId}.`);
        return;
    }
    const crispLink = `https://app.crisp.chat/website/${websiteId}/inbox/${sessionId}/`;
    // ... (rest of the function is the same, just uses the passed config)
    const payload = { /* ... payload ... */ };
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


// (postPrivateNoteToCrisp and tagCrispConversation remain largely unchanged but are called with config values)
async function postPrivateNoteToCrisp(websiteId, sessionId, noteContent) { /* ... */ }
async function tagCrispConversation(websiteId, sessionId, tag) { /* ... */ }


/**
 * **MODIFIED**: Process a message using the specific config for its website_id.
 */
async function processMessage(data) {
    try {
        const { website_id, session_id, content, user_id, timestamp } = data;
        if (!website_id || !session_id || typeof content !== 'string') {
            console.warn(`[${new Date().toISOString()}] Invalid data received in webhook.`, data);
            return;
        }

        // **MODIFIED**: Load the specific configuration for this website.
        const config = loadPluginConfig(website_id);

        const normalizedContent = content.replace(/[^a-zA-Z0-9\s]/g, '');

        if (profanity.exists(content) || profanity.exists(normalizedContent)) {
            const analysis = sentiment.analyze(content);

            // **MODIFIED**: Use the threshold from the loaded config.
            if (analysis.comparative < config.negativeThreshold) {
                console.log(`[${new Date().toISOString()}] Negative sentiment for ${website_id} (Score: ${analysis.comparative.toFixed(2)}). Triggering alert.`);
                const profaneWords = getAllProfanitiesInMessage(content);
                const uniqueProfaneWords = [...new Set(profaneWords)];
                
                // **MODIFIED**: Pass config to highlighting function.
                const highlightedMessage = highlightProfanity(content, config);
                const sentimentSummary = getSentimentSummary(analysis.comparative);

                const note = [
                    "**Profanity & Negative Tone Alert**",
                    `A customer message containing profanity and a negative tone was detected:`,
                    `> ${highlightedMessage}`,
                    "",
                    `*Sentiment Score:* ${analysis.comparative.toFixed(2)} (${sentimentSummary})`,
                    uniqueProfaneWords.length ? `*Profane Words Detected:* ${uniqueProfaneWords.map(w => `\`${w}\``).join(', ')}` : "",
                    `*Session ID:* ${session_id}`,
                    user_id ? `*User ID:* ${user_id}` : "",
                    timestamp ? `*Timestamp:* ${new Date(timestamp).toISOString()}` : "",
                ].filter(Boolean).join('\n');

                await Promise.allSettled([
                    postPrivateNoteToCrisp(website_id, session_id, note),
                    // **MODIFIED**: Pass website_id and loaded config to notification function.
                    sendSlackNotification(note, session_id, website_id, config, {
                        sentimentScore: analysis.comparative,
                        sentimentSummary,
                        profaneWords: uniqueProfaneWords,
                        messageTimestamp: timestamp ? new Date(timestamp).toISOString() : undefined,
                        userId: user_id
                    }),
                    // **MODIFIED**: Use the tag from the loaded config.
                    tagCrispConversation(website_id, session_id, config.tagToApply)
                ]);
            } else {
                console.log(`[${new Date().toISOString()}] Profanity found for ${website_id}, but sentiment is neutral/positive (Score: ${analysis.comparative.toFixed(2)}). No alert sent.`);
            }
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error during message processing:`, error);
    }
}

// Webhook endpoint (logic is now in processMessage)
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

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
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
