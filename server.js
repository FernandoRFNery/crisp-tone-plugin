/**
 * Tone Detection & Profanity Alert Server (Crisp Plugin Edition)
 * --------------------------------------------------------------
 * This version exposes a simple plugin configuration API for Crisp plugin UI integration.
 * Admins can GET/POST plugin config (tag/segment and negative threshold) via /plugin-config.
 * 
 * Usage:
 *   - All secrets (CRISP_IDENTIFIER, CRISP_KEY, SLACK_WEBHOOK_URL, CRISP_WEBSITE_ID) remain in .env.
 *   - Tag (segment) and negative threshold are editable via the plugin config API.
 *   - The plugin config is stored in-memory by default, but can be extended to persist (e.g., DB, file).
 * 
 * Endpoints:
 *   - GET  /plugin-config   (returns current config)
 *   - POST /plugin-config   (accepts { tagToApply, negativeThreshold })
 *   - POST /webhook         (Crisp webhook, unchanged)
 *   - GET  /health          (health check)
 */

require('dotenv').config();

const path = require("path");
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Profanity } = require('@2toad/profanity');
const Sentiment = require('sentiment');
const fetch = require('node-fetch');

const app = express(); // <-- FIXED: app is now declared before use
const PORT = process.env.PORT || 8080;
const profanity = new Profanity();
const sentiment = new Sentiment();

app.set('trust proxy', 1);
app.use(helmet());
app.use(bodyParser.json());

const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);
// Serve plugin.json with correct content-type (Crisp compatibility)
app.get("/plugin.json", (req, res) => {
    res.type("application/json");
    res.sendFile(path.join(__dirname, "public", "plugin.json"));
});

// Serve static plugin files (e.g. plugin.json)
app.use(express.static(path.join(__dirname, "public")));

// --- ⬇️ CONFIGURATION (Secrets from env, plugin config editable via API) ⬇️ ---

const CRISP_IDENTIFIER = process.env.CRISP_IDENTIFIER;
const CRISP_KEY = process.env.CRISP_KEY;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const CRISP_WEBSITE_ID = process.env.CRISP_WEBSITE_ID;

if (!CRISP_IDENTIFIER || !CRISP_KEY || !SLACK_WEBHOOK_URL || !CRISP_WEBSITE_ID) {
    console.error("Missing required environment variables. Please set CRISP_IDENTIFIER, CRISP_KEY, SLACK_WEBHOOK_URL, and CRISP_WEBSITE_ID.");
    process.exit(1);
}

// --- Plugin Config (editable via API) ---
// Default values (can be overridden via POST /plugin-config)
let pluginConfig = {
    tagToApply: process.env.TAG_TO_APPLY || "profanity-alert",
    negativeThreshold: typeof process.env.NEGATIVE_THRESHOLD !== "undefined"
        ? Number(process.env.NEGATIVE_THRESHOLD)
        : 0
};

// --- Plugin Config API (for Crisp plugin UI) ---

/**
 * GET /plugin-config
 * Returns the current plugin config (tagToApply, negativeThreshold)
 */
app.get('/plugin-config', (req, res) => {
    res.status(200).json({
        tagToApply: pluginConfig.tagToApply,
        negativeThreshold: pluginConfig.negativeThreshold
    });
});

/**
 * POST /plugin-config
 * Accepts { tagToApply, negativeThreshold }
 * Example: { "tagToApply": "urgent", "negativeThreshold": -0.5 }
 */
app.post('/plugin-config', (req, res) => {
    const { tagToApply, negativeThreshold } = req.body || {};
    let updated = false;
    let errors = [];

    if (typeof tagToApply === "string" && tagToApply.trim().length > 0) {
        pluginConfig.tagToApply = tagToApply.trim();
        updated = true;
    } else if (typeof tagToApply !== "undefined") {
        errors.push("tagToApply must be a non-empty string.");
    }

    if (
        typeof negativeThreshold === "number" &&
        isFinite(negativeThreshold)
    ) {
        pluginConfig.negativeThreshold = negativeThreshold;
        updated = true;
    } else if (typeof negativeThreshold !== "undefined") {
        errors.push("negativeThreshold must be a number.");
    }

    if (errors.length > 0) {
        return res.status(400).json({ ok: false, errors });
    }
    if (updated) {
        return res.status(200).json({
            ok: true,
            tagToApply: pluginConfig.tagToApply,
            negativeThreshold: pluginConfig.negativeThreshold
        });
    }
    return res.status(400).json({ ok: false, error: "No valid fields provided." });
});

// --- ⬆️ END CONFIGURATION ⬆️ ---

function getAuth() {
    return Buffer.from(`${CRISP_IDENTIFIER}:${CRISP_KEY}`).toString('base64');
}

function getAllProfanitiesInMessage(message) {
    if (typeof message !== 'string' || !message.length) return [];
    if (
        !profanity ||
        !Array.isArray(profanity.list) ||
        profanity.list.length === 0
    ) {
        return [];
    }
    const profaneList = profanity.list
        .filter(w => typeof w === 'string' && w.length > 0)
        .map(w => w.toLowerCase());
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

function highlightProfanity(message) {
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
    const payload = {
        type: "note",
        from: "operator",
        origin: "chat",
        content: noteContent
    };
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
        } else {
            console.log(`[${new Date().toISOString()}] Private note posted to Crisp.`);
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error posting note to Crisp:`, error);
    }
}

async function tagCrispConversation(websiteId, sessionId, tag) {
    const metaUrl = `https://api.crisp.chat/v1/website/${websiteId}/conversation/${sessionId}/meta`;
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${getAuth()}`,
        'X-Crisp-Tier': 'plugin'
    };
    try {
        const metaResponse = await fetch(metaUrl, { headers });
        if (!metaResponse.ok) {
            console.error(`[${new Date().toISOString()}] Failed to get conversation metadata:`, metaResponse.status, await metaResponse.text());
            return;
        }
        const metadata = await metaResponse.json();

        let existingSegments = [];
        if (Array.isArray(metadata?.data?.segments)) {
            if (metadata.data.segments.length > 0 && typeof metadata.data.segments[0] === "object" && metadata.data.segments[0] !== null && "name" in metadata.data.segments[0]) {
                existingSegments = metadata.data.segments.map(seg => seg.name);
            } else if (typeof metadata.data.segments[0] === "string") {
                existingSegments = metadata.data.segments;
            }
        }

        existingSegments = Array.from(new Set(existingSegments.filter(Boolean)));

        const normalizedTag = typeof tag === "string" ? tag.trim().toLowerCase() : "";
        if (!normalizedTag) {
            console.error(`[${new Date().toISOString()}] Invalid tag provided to tagCrispConversation.`);
            return;
        }
        if (existingSegments.map(t => t.trim().toLowerCase()).includes(normalizedTag)) {
            console.log(`[${new Date().toISOString()}] Tag "${normalizedTag}" already exists. Skipping.`);
            return;
        }

        const updatedSegmentsStrings = [...existingSegments, normalizedTag]
            .map(name => (typeof name === "string" ? name.trim().toLowerCase() : ""))
            .filter(Boolean)
            .filter((v, i, arr) => arr.indexOf(v) === i);

        let patchResponse = await fetch(metaUrl, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ segments: updatedSegmentsStrings })
        });

        if (patchResponse.ok) {
            console.log(`[${new Date().toISOString()}] Tagged conversation with "${normalizedTag}".`);
            return;
        } else {
            const errorText = await patchResponse.text();
            let errorJson;
            try { errorJson = JSON.parse(errorText); } catch { errorJson = null; }
            if (
                patchResponse.status === 400 &&
                errorJson &&
                errorJson.data &&
                typeof errorJson.data.message === "string" &&
                errorJson.data.message.includes("should be string")
            ) {
                console.error(`[${new Date().toISOString()}] Failed to tag conversation:`, patchResponse.status, errorText);
                return;
            }

            const updatedSegmentsObjects = updatedSegmentsStrings.map(name => ({ name }));
            patchResponse = await fetch(metaUrl, {
                method: 'PATCH',
                headers,
                body: JSON.stringify({ segments: updatedSegmentsObjects })
            });

            if (!patchResponse.ok) {
                const fallbackErrorText = await patchResponse.text();
                console.error(`[${new Date().toISOString()}] Failed to tag conversation:`, patchResponse.status, fallbackErrorText);
            } else {
                console.log(`[${new Date().toISOString()}] Tagged conversation with "${normalizedTag}" (object fallback).`);
            }
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error tagging conversation:`, error);
    }
}

async function sendSlackNotification(alertNote, sessionId, alertDetails = {}) {
    if (!SLACK_WEBHOOK_URL) {
        console.log(`[${new Date().toISOString()}] Slack Webhook URL not configured. Skipping notification.`);
        return;
    }
    const crispLink = `https://app.crisp.chat/website/${CRISP_WEBSITE_ID}/inbox/${sessionId}/`;
    const {
        sentimentScore,
        sentimentSummary,
        profaneWords,
        messageTimestamp,
        userId
    } = alertDetails;

    const contextFields = [];
    if (typeof sentimentScore === "number") {
        contextFields.push({
            type: "mrkdwn",
            text: `*Sentiment Score:* ${sentimentScore.toFixed(2)} (${sentimentSummary || getSentimentSummary(sentimentScore)})`
        });
    }
    if (profaneWords && profaneWords.length) {
        contextFields.push({
            type: "mrkdwn",
            text: `*Profane Words:* ${profaneWords.map(w => `\`${w}\``).join(', ')}`
        });
    }
    if (messageTimestamp) {
        contextFields.push({
            type: "mrkdwn",
            text: `*Timestamp:* ${messageTimestamp}`
        });
    }
    if (userId) {
        contextFields.push({
            type: "mrkdwn",
            text: `*User ID:* ${userId}`
        });
    }

    const payload = {
        text: "Negative & Profane Customer Message Detected",
        blocks: [
            {
                type: "header",
                text: { type: "plain_text", text: "🚨 Profanity & Negative Tone Detected", emoji: true }
            },
            {
                type: "section",
                text: { type: "mrkdwn", text: alertNote.replace(/\*\*/g, '*') }
            },
            ...(contextFields.length
                ? [{ type: "context", elements: contextFields }]
                : []),
            {
                type: "actions",
                elements: [
                    {
                        type: "button",
                        text: { type: "plain_text", text: "View in Crisp", emoji: true },
                        style: "primary",
                        url: crispLink
                    }
                ]
            },
            {
                type: "context",
                elements: [
                    {
                        type: "mrkdwn",
                        text: "_Please review the conversation and take appropriate action. If escalation is needed, notify your team lead._"
                    }
                ]
            }
        ]
    };
    try {
        const response = await fetch(SLACK_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            console.error(`[${new Date().toISOString()}] Failed to send Slack notification:`, response.status, await response.text());
        } else {
            console.log(`[${new Date().toISOString()}] Slack notification sent.`);
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error sending Slack notification:`, error);
    }
}

/**
 * Process a user message for profanity and negative sentiment.
 * Uses pluginConfig for tag and threshold.
 */
async function processMessage(data) {
    try {
        if (!data || typeof data.content !== 'string') {
            console.warn(`[${new Date().toISOString()}] No message content to process.`);
            return;
        }
        const { website_id, session_id, content, user_id, timestamp } = data;
        if (!website_id || !session_id) {
            console.warn(`[${new Date().toISOString()}] Missing website_id or session_id in data.`);
            return;
        }
        const normalizedContent = content.replace(/[^a-zA-Z0-9\s]/g, '');

        // Profanity check
        if (profanity.exists(content) || profanity.exists(normalizedContent)) {
            console.log(`[${new Date().toISOString()}] Profanity detected. Checking sentiment...`);
            const analysis = sentiment.analyze(content);
            if (analysis.comparative < pluginConfig.negativeThreshold) {
                console.log(`[${new Date().toISOString()}] Negative sentiment (Score: ${analysis.comparative.toFixed(2)}). Triggering alert.`);
                let profaneWords = [];
                try {
                    profaneWords = getAllProfanitiesInMessage(content);
                } catch (err) {
                    console.error(`[${new Date().toISOString()}] Error in getAllProfanitiesInMessage:`, err);
                    profaneWords = [];
                }
                const uniqueProfaneWords = Array.isArray(profaneWords) && profaneWords.length > 0
                    ? [...new Set(profaneWords)]
                    : [];
                const highlightedMessage = highlightProfanity(content);
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
                    "",
                    "_Please review the conversation and take appropriate action. If escalation is needed, notify your team lead._"
                ].filter(Boolean).join('\n');

                await Promise.allSettled([
                    postPrivateNoteToCrisp(website_id, session_id, note),
                    sendSlackNotification(note, session_id, {
                        sentimentScore: analysis.comparative,
                        sentimentSummary,
                        profaneWords: uniqueProfaneWords,
                        messageTimestamp: timestamp ? new Date(timestamp).toISOString() : undefined,
                        userId: user_id
                    }),
                    tagCrispConversation(website_id, session_id, pluginConfig.tagToApply)
                ]);
            } else {
                console.log(`[${new Date().toISOString()}] Profanity found, but sentiment is neutral/positive (Score: ${analysis.comparative.toFixed(2)}). No alert sent.`);
            }
        } else {
            console.log(`[${new Date().toISOString()}] Message is clean.`);
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
        if (
            event === 'message:send' &&
            data &&
            data.from === 'user' &&
            data.type === 'text' &&
            typeof data.content === 'string'
        ) {
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
    console.log(`[${new Date().toISOString()}] Crisp & Slack Profanity Detector (Plugin Edition) running at http://localhost:${PORT}`);
    console.log("Plugin config API: GET/POST /plugin-config");
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error(`[${new Date().toISOString()}] Unhandled Rejection:`, reason);
});
process.on('uncaughtException', (err) => {
    console.error(`[${new Date().toISOString()}] Uncaught Exception:`, err);
    process.exit(1);
});
