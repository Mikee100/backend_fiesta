import axios from 'axios';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import prisma from '../../config/prisma';
import { getStudioCatalogPromptSummary } from './studio-wardrobe.catalog';

dotenv.config();

export interface OutfitAnalysisResult {
  outfitDescription: string;
  category:
    | 'gown'
    | 'power_suit'
    | 'dress'
    | 'robe'
    | 'bodysuit'
    | 'silk_wrap'
    | 'personal_outfit'
    | 'other';
  primaryColor: string;
  styleDetails: string;

  /**
   * True when the image visually resembles a style represented
   * in the Fiesta House studio catalog.
   *
   * This does NOT mean the exact item is confirmed to be in studio.
   */
  isInStudioWardrobeStyle: boolean;

  /**
   * True only when our application has enough evidence to treat
   * the image as an actual Fiesta House studio piece.
   */
  isStudioPiece: boolean;

  /**
   * Exact catalog item name when a verified studio match exists.
   */
  matchedStudioItemName?: string | null;

  customerIntent:
    | 'inspiration'
    | 'bringing_own'
    | 'inquiry'
    | 'general';

  customerReply: string;
  photographerNotes: string;
}

export interface HandleImageParams {
  platform: 'whatsapp' | 'instagram';
  customerId: string;
  imageId?: string;
  imageUrl?: string;
  caption?: string;
}

export class VisionService {
  private getWhatsAppApiVersion(): string {
    return process.env.WHATSAPP_API_VERSION || 'v25.0';
  }

  /**
   * Downloads media from WhatsApp Cloud API or 360dialog.
   */
  async downloadWhatsAppMedia(
    mediaId: string
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    const provider = process.env.WHATSAPP_PROVIDER || 'meta';

    if (provider === '360dialog') {
      const apiKey = process.env.D360_API_KEY;

      if (!apiKey) {
        throw new Error('D360_API_KEY missing in .env');
      }

      const mediaBaseUrl =
        process.env.D360_MEDIA_BASE_URL ||
        'https://waba-v2.360dialog.io';

      const response = await axios.get(
        `${mediaBaseUrl}/${mediaId}`,
        {
          headers: {
            'D360-API-KEY': apiKey,
          },
          responseType: 'arraybuffer',
        }
      );

      const mimeType = String(
        response.headers['content-type'] || 'image/jpeg'
      );

      return {
        buffer: Buffer.from(response.data),
        mimeType,
      };
    }

    // Meta Graph API
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

    if (!accessToken) {
      throw new Error(
        'WHATSAPP_ACCESS_TOKEN missing in .env'
      );
    }

    // 1. Retrieve the media URL from the Graph API
    const metaMediaRes = await axios.get(
      `https://graph.facebook.com/${this.getWhatsAppApiVersion()}/${mediaId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        timeout: 15000,
      }
    );

    const downloadUrl = metaMediaRes.data?.url;
    const mimeType =
      metaMediaRes.data?.mime_type || 'image/jpeg';

    if (!downloadUrl) {
      throw new Error(
        `Failed to retrieve download URL for WhatsApp media ${mediaId}`
      );
    }

    // 2. Download the binary stream with auth header
    const fileRes = await axios.get(downloadUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      responseType: 'arraybuffer',
      timeout: 25000,
    });

    return {
      buffer: Buffer.from(fileRes.data),
      mimeType,
    };
  }

  /**
   * Downloads media from an Instagram attachment URL.
   */
  async downloadInstagramMedia(
    url: string
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 25000,
    });

    const mimeType = String(
      response.headers['content-type'] || 'image/jpeg'
    );

    return {
      buffer: Buffer.from(response.data),
      mimeType,
    };
  }

  /**
   * Analyzes an image with Gemini Vision
   * and falls back to OpenAI Vision if available.
   */
  async analyzeOutfitImage(
    imageBuffer: Buffer,
    mimeType: string,
    caption?: string,
    platform?: string
  ): Promise<OutfitAnalysisResult> {
    const base64Data = imageBuffer.toString('base64');
    const promptText = this.buildPrompt(
      caption,
      platform
    );

    const catalogSummary =
      getStudioCatalogPromptSummary();

    // Try Gemini Native REST API with key/model failover.
    const geminiKeys = [
      process.env.GEMINI_API_KEY,
      process.env.GEMINI_BACKUP2,
    ].filter(Boolean) as string[];

    const preferredModel =
      process.env.GEMINI_CHAT_MODEL ||
      'gemini-3.8-flash';

    const candidateModels = Array.from(
      new Set([
        preferredModel,
        'gemini-3.8-flash',
        'gemini-2.5-flash',
        'gemini-2.0-flash',
      ])
    );

    for (const key of geminiKeys) {
      for (const model of candidateModels) {
        try {
          const url =
            `https://generativelanguage.googleapis.com/v1beta/models/` +
            `${model}:generateContent?key=${key}`;

          const response = await axios.post(
            url,
            {
              contents: [
                {
                  parts: [
                    {
                      text: promptText,
                    },
                    {
                      inlineData: {
                        mimeType:
                          mimeType || 'image/jpeg',
                        data: base64Data,
                      },
                    },
                  ],
                },
              ],
              generationConfig: {
                responseMimeType: 'application/json',
                temperature: 0.3,
              },
            },
            {
              timeout: 25000,
            }
          );

          const candidates =
            response.data?.candidates;

          const textContent =
            candidates?.[0]?.content?.parts?.[0]?.text;

          if (textContent) {
            const parsed = JSON.parse(textContent);

            return this.sanitizeAnalysisResult(
              parsed,
              caption,
              catalogSummary
            );
          }
        } catch (geminiError: any) {
          const status =
            geminiError?.response?.status;

          const msg =
            geminiError?.response?.data?.error
              ?.message ||
            geminiError.message;

          console.warn(
            `[VisionService] Gemini attempt failed ` +
              `(key=${key.slice(0, 8)}... ` +
              `model=${model} status=${status}): ${msg}`
          );

          if (status === 503) {
            await new Promise((resolve) =>
              setTimeout(resolve, 600)
            );
          }
        }
      }
    }

    // Fallback: OpenAI GPT-4o Vision if available.
    const openAiKey = process.env.OPENAI_API_KEY;

    if (openAiKey) {
      try {
        const client = new OpenAI({
          apiKey: openAiKey,
          timeout: 25000,
        });

        const openAiModel =
          process.env.OPENAI_MODEL || 'gpt-4o';

        const completion =
          await client.chat.completions.create({
            model: openAiModel,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: promptText,
                  },
                  {
                    type: 'image_url',
                    image_url: {
                      url:
                        `data:${mimeType || 'image/jpeg'};base64,` +
                        base64Data,
                    },
                  },
                ],
              },
            ],
            response_format: {
              type: 'json_object',
            },
            temperature: 0.3,
          });

        const textContent =
          completion.choices[0]?.message?.content;

        if (textContent) {
          const parsed = JSON.parse(textContent);

          return this.sanitizeAnalysisResult(
            parsed,
            caption,
            catalogSummary
          );
        }
      } catch (openAiError: any) {
        console.error(
          '[VisionService] OpenAI Vision fallback failed:',
          openAiError.message
        );
      }
    }

    // Default fallback when AI vision is unavailable.
    return this.createFallbackResult(caption);
  }

  /**
   * Builds the vision prompt.
   *
   * IMPORTANT:
   * Vision is allowed to describe and compare the image,
   * but it must not invent inventory availability.
   */
  private buildPrompt(
    caption?: string,
    platform?: string
  ): string {
    const catalogSummary =
      getStudioCatalogPromptSummary();

    return `
You are the lead luxury maternity stylist and AI assistant for Fiesta House Maternity photography studio in Nairobi, Kenya.

A client just sent an image in the chat${
      caption
        ? ` with the message/caption: "${caption}"`
        : ''
    }.

Platform: ${platform || 'unknown'}

CHECK AGAINST OUR STUDIO CATALOG FIRST
Compare the image against the catalog below before identifying a studio piece. Visual similarity alone does not prove inventory or current availability.

FIESTA ATELIER STUDIO WARDROBE CATALOG:

${catalogSummary}

IMPORTANT BUSINESS RULE:

The image may be:
1. An actual Fiesta House studio wardrobe piece.
2. An external Pinterest/inspiration image.
3. A personal outfit belonging to the customer.
4. A similar-looking outfit from another designer or studio.

DO NOT assume that visual similarity proves that an item belongs to Fiesta House.

A photo that looks similar to one of our catalog pieces must NOT automatically be described as an actual Fiesta House item.

The exact inventory truth must never be invented.

--------------------------------------------------
IMAGE ANALYSIS
--------------------------------------------------

First, analyze what is actually visible in the image:

- Color
- Silhouette
- Neckline
- Fabric
- Draping
- Train
- Sleeves
- Bows
- Crowns
- Headpieces
- Gloves
- Cape wings
- High slits
- Flying silks
- Power-suit elements
- Other distinctive styling details

Then compare the visual appearance against the catalog.

You may identify a POSSIBLE visual match.

However:

VISUAL SIMILARITY != CONFIRMED STUDIO INVENTORY.

--------------------------------------------------
STUDIO CATALOG MATCHING
--------------------------------------------------

If the image strongly resembles a specific catalog item:

- Set "isInStudioWardrobeStyle": true.
- You may put the closest catalog item name in "matchedStudioItemName".
- Do NOT automatically set "isStudioPiece": true.

"matchedStudioItemName" means:

"The catalog item this image visually resembles."

It does NOT by itself mean:

"The exact physical item in this image has been verified as Fiesta House inventory."

Only set:

"isStudioPiece": true

when the image itself clearly represents the specific Fiesta House catalog piece rather than merely resembling it.

When uncertain, ALWAYS prefer:

"isStudioPiece": false.

Never claim:

- "This exact piece is in stock"
- "This will be ready for your session"
- "This is definitely ours"
- "This is part of our wardrobe"

unless the evidence is sufficiently strong.

--------------------------------------------------
IF THE IMAGE IS NOT CONFIRMED AS A STUDIO PIECE
--------------------------------------------------

Set:

"isStudioPiece": false

You may still set:

"isInStudioWardrobeStyle": true

if the style resembles one of our wardrobe styles.

The customer-facing response must be honest.

Explain that the image is a beautiful styling reference and that Fiesta House has over 300 luxury maternity gowns and styling options with similar colors, silhouettes and details.

Do not claim that the exact item is available.

The customer may also bring the pictured outfit if they own it.

--------------------------------------------------
IF THE IMAGE IS CLEARLY A FIESTA HOUSE STUDIO PIECE
--------------------------------------------------

Only when you are genuinely confident that the image represents the specific catalog item:

- Set "isStudioPiece": true.
- Set "matchedStudioItemName" to the exact catalog name.
- You may confirm that it is a Fiesta House studio piece.

Do not invent additional availability information.

Do not say an item "will definitely be ready" unless that information is explicitly provided by the catalog/context.

--------------------------------------------------
CUSTOMER INTENT
--------------------------------------------------

Determine whether the customer appears to be:

"inspiration"
- sharing an outfit as a reference.

"bringing_own"
- indicating that they own/want to bring the outfit.

"inquiry"
- asking whether Fiesta House has the outfit or asking about it.

"general"
- unclear/general image sharing.

--------------------------------------------------
CAPTION QUESTIONS
--------------------------------------------------

If the client included a question in the caption, answer the question directly.

Examples:

"Do you have this outfit?"
"Can I wear this at 32 weeks?"
"Can I bring this?"
"How much is this?"
"Can I choose this gown?"

Do not invent pricing or availability.

--------------------------------------------------
CUSTOMER REPLY
--------------------------------------------------

Write a natural, personalised reply to the customer.

Use the image analysis and the customer's actual caption
to decide what is relevant to say. Do not follow a fixed
response template.

The reply should:
- Sound like a warm, knowledgeable luxury maternity stylist.
- Directly answer the customer's question when possible.
- Mention visual details when they help answer the question.
- Be concise, usually 1-4 sentences.
- Feel appropriate for a WhatsApp or Instagram conversation.
- Use an emoji naturally where appropriate.

Avoid:
- Repeating the customer's message back to them.
- Starting every response with the same compliment.
- Repeatedly mentioning that a styling note was saved.
- Giving unnecessary explanations when a direct answer is enough.
- Asking about booking or offering to check session dates.
- Inventing prices, item availability, or package inclusions.

If "isStudioPiece" is false:
- Never identify the exact pictured outfit as a confirmed
  Fiesta House item.
- You may explain that it resembles styles in our wardrobe
  if "isInStudioWardrobeStyle" is true.
- If the exact item cannot be confirmed, say so naturally
  when it is relevant to the customer's question.
- You may mention similar styles or bringing a personal
  outfit when relevant.

If "isStudioPiece" is true:
- You may identify the verified item using its exact
  catalogue name.
- Do not imply that it is currently available, reserved,
  or guaranteed to be ready unless explicitly confirmed.

If the customer asks about price, availability, fit,
or another detail you cannot verify from the provided
information, be transparent about that limitation.
Do not invent an answer just to sound confident.


--------------------------------------------------
PHOTOGRAPHER NOTES
--------------------------------------------------

Create a brief 1-2 sentence internal note for the photographer/stylist.

Clearly distinguish:

- confirmed studio piece
- visual match/inspiration
- personal outfit

Do not tell the photographer that an external reference is confirmed inventory.

--------------------------------------------------
RETURN FORMAT
--------------------------------------------------

Return ONLY a valid JSON object matching this schema:

{
  "outfitDescription": "Concise description of the outfit/clothing in the image",
  "category": "gown" | "power_suit" | "dress" | "robe" | "bodysuit" | "silk_wrap" | "personal_outfit" | "other",
  "primaryColor": "Color name (e.g. 'Champagne gold', 'Emerald green', 'White')",
  "styleDetails": "Details regarding cut, neckline, fabric, train, or silhouette",
  "isInStudioWardrobeStyle": boolean,
  "isStudioPiece": boolean,
  "matchedStudioItemName": string | null,
  "customerIntent": "inspiration" | "bringing_own" | "inquiry" | "general",
  "customerReply": "The exact message to send to the customer on chat",
  "photographerNotes": "Brief 1-2 sentence note for the photographer and stylist on session day"
}
`;
  }

  /**
   * Sanitizes the AI response and applies deterministic
   * business rules before anything is sent to the customer.
   */
  private sanitizeAnalysisResult(
    parsed: any,
    caption?: string,
    catalogSummary: string = getStudioCatalogPromptSummary()
  ): OutfitAnalysisResult {
    const allowedCategories = [
      'gown',
      'power_suit',
      'dress',
      'robe',
      'bodysuit',
      'silk_wrap',
      'personal_outfit',
      'other',
    ];

    const allowedIntents = [
      'inspiration',
      'bringing_own',
      'inquiry',
      'general',
    ];

    const outfitDescription = String(
      parsed.outfitDescription ||
        'Maternity outfit/gown reference'
    ).trim();

    const category = allowedCategories.includes(
      parsed.category
    )
      ? parsed.category
      : 'gown';

    const primaryColor = String(
      parsed.primaryColor || 'Unspecified'
    ).trim();

    const styleDetails = String(
      parsed.styleDetails || ''
    ).trim();

    const customerIntent =
      allowedIntents.includes(
        parsed.customerIntent
      )
        ? parsed.customerIntent
        : 'inspiration';

    const rawMatchedName =
      parsed.matchedStudioItemName
        ? String(
            parsed.matchedStudioItemName
          ).trim()
        : null;

    /*
     * IMPORTANT:
     *
     * We don't blindly trust the model's isStudioPiece flag.
     *
     * If the model says an item is a studio piece,
     * there must at least be an exact catalog-name reference
     * present in our catalog summary.
     *
     * This prevents the model from inventing completely
     * new Fiesta House wardrobe names.
     */
    const catalogContainsMatch =
      Boolean(
        rawMatchedName &&
          catalogSummary &&
          this.catalogContainsExactItem(
            catalogSummary,
            rawMatchedName
          )
      );

    const isStudioPiece =
      Boolean(parsed.isStudioPiece) &&
      catalogContainsMatch;

    const matchedStudioItemName =
      isStudioPiece
        ? rawMatchedName
        : null;

    const isInStudioWardrobeStyle =
      Boolean(
        parsed.isInStudioWardrobeStyle
      );

    /*
     * CRITICAL CUSTOMER-SAFETY RULE:
     *
     * If the item is NOT verified as a Fiesta House
     * studio piece, we do not trust Gemini's customerReply.
     *
     * This prevents responses such as:
     *
     * "Yes! That's our Champagne Gold Goddess..."
     *
     * when the model only saw a visually similar image.
     */
    let customerReply: string;

    if (isStudioPiece) {
      customerReply =
        this.buildVerifiedStudioReply(
          matchedStudioItemName!,
          caption
        );
    } else {
      customerReply =
        this.buildExternalReferenceReply(
          {
            outfitDescription,
            category,
            primaryColor,
            styleDetails,
            customerIntent,
            isInStudioWardrobeStyle,
          },
          caption
        );
    }

    const photographerNotes = String(
      parsed.photographerNotes ||
        outfitDescription ||
        ''
    ).trim();

    return {
      outfitDescription,
      category,
      primaryColor,
      styleDetails,
      isInStudioWardrobeStyle,
      isStudioPiece,
      matchedStudioItemName,
      customerIntent,
      customerReply,
      photographerNotes,
    };
  }

  /**
   * Checks whether the exact model-provided item name exists
   * in the studio catalog summary.
   *
   * This is intentionally conservative.
   */

  
  private catalogContainsExactItem(
    catalogSummary: string,
    itemName: string
  ): boolean {
    const catalog = catalogSummary
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    const item = itemName
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    if (!catalog || !item) {
      return false;
    }

    return catalog.includes(item);
  }

  /**
   * Customer-facing reply for a verified studio piece.
   */
private buildVerifiedStudioReply(
  matchedStudioItemName: string,
  caption?: string
): string {
  const safeName =
    matchedStudioItemName.trim();

  return (
    `Yes! ✨ This is our ${safeName}. ` +
    `It's one of the signature looks in our studio wardrobe, ` +
    `and our styling team can help you with the fit and finishing ` +
    `details for your session. ` +
    `I've saved this look to your session styling notes.`
  );
}

  /**
   * Customer-facing reply for an external reference,
   * personal outfit, or uncertain catalog match.
   */
private buildExternalReferenceReply(
  parsed: {
    outfitDescription: string;
    category: string;
    primaryColor: string;
    styleDetails: string;
    customerIntent: string;
    isInStudioWardrobeStyle: boolean;
  },
  caption?: string
): string {
  const color =
    parsed.primaryColor &&
    parsed.primaryColor.toLowerCase() !== 'unspecified'
      ? parsed.primaryColor.trim()
      : '';

  const outfit =
    parsed.outfitDescription?.trim() ||
    'beautiful look';

  // Avoid awkward duplication such as:
  // "Scarlet red A vibrant red, form-fitting gown..."
  const outfitAlreadyContainsColor =
    color &&
    outfit.toLowerCase().includes(color.toLowerCase());

  const opening = outfitAlreadyContainsColor
    ? `What a gorgeous look! ✨`
    : color
      ? `What a gorgeous ${color} ${outfit}! ✨`
      : `What a gorgeous ${outfit}! ✨`;

  let middle =
    `While I can't confirm that this exact piece is ours from the photo alone, ` +
    `our studio wardrobe features over 300 luxury maternity gowns and styling ` +
    `options with a wide range of colors, silhouettes and details for you to explore.`;

  if (
    parsed.customerIntent === 'bringing_own'
  ) {
    middle =
      `It's a beautiful choice. 🤍 I can't confirm from the photo alone whether this exact piece is part of our studio wardrobe or an external design, but you are warmly welcome to bring your own outfit ` +
      `for the session, and our styling team can help you incorporate it beautifully. ` +
      `We also have over 300 luxury maternity gowns and styling options in our studio wardrobe.`;
  }

  if (
    parsed.isInStudioWardrobeStyle &&
    parsed.customerIntent !== 'bringing_own'
  ) {
    middle =
      `This look is very similar to styles we offer in our studio wardrobe. ` +
      `While I can't confirm that this exact piece is ours from the photo alone, ` +
      `we have over 300 luxury maternity gowns and styling options with similar ` +
      `colors, silhouettes and details for you to explore.`;
  }

  return (
    `${opening} ${middle} ` +
    `I've saved this look as a styling reference for you.`
  );
}
  /**
   * Determines whether the caption appears to contain
   * a direct question.
   */
  private isQuestionCaption(
    caption: string
  ): boolean {
    const text = caption.trim().toLowerCase();

    return (
      text.includes('?') ||
      /^(do|does|can|could|would|will|is|are|what|which|how|where|when|why|who|may|should)\b/.test(
        text
      )
    );
  }

  /**
   * Fallback when vision is unavailable.
   *
   * IMPORTANT:
   * We do not claim the image resembles the studio wardrobe
   * because we were unable to analyze it.
   */
  private createFallbackResult(
    caption?: string
  ): OutfitAnalysisResult {
    const questionReply = caption
      ? ` I also noted your message: "${caption}".`
      : '';

    return {
      outfitDescription:
        'Customer shared an outfit/styling photo',

      category: 'gown',

      primaryColor:
        'Unable to determine',

      styleDetails:
        'Client shared styling inspiration; image analysis was unavailable.',

      isInStudioWardrobeStyle: false,

      isStudioPiece: false,

      matchedStudioItemName: null,

      customerIntent:
        caption &&
        caption.toLowerCase().includes('bring')
          ? 'bringing_own'
          : 'inspiration',

      customerReply:
        `Thank you for sharing this lovely inspiration! ✨${questionReply} ` +
        `I wasn't able to fully analyze the image just now, but I've saved ` +
        `the shared look to your session notes for our styling team. ` +
        `Our studio wardrobe features over 300 luxury maternity gowns and ` +
        `styling options, and you're also warmly welcome to bring your own outfit. ` +
        `Would you like me to check available session dates for you? 🤍`,

      photographerNotes:
        `Client shared an outfit photo reference${
          caption
            ? ` (Note: "${caption}")`
            : ''
        }. Image analysis was unavailable.`,
    };
  }

  /**
   * Saves the recognized outfit to CustomerSessionNote
   * and updates CustomerMemory.
   */
  async saveStylingNote(params: {
    customerId: string;
    analysis: OutfitAnalysisResult;
    platform: string;
    sourceMessage?: string;
    caption?: string;
  }) {
    const {
      customerId,
      analysis,
      platform,
      sourceMessage,
      caption,
    } = params;

    try {
      // 1. Ensure customer exists in database.
      let customer =
        await prisma.customer.findUnique({
          where: {
            id: customerId,
          },
        });

      if (!customer) {
        customer =
          await prisma.customer.create({
            data: {
              id: customerId,
              name:
                platform === 'instagram'
                  ? 'Instagram User'
                  : 'WhatsApp User',

              whatsappId:
                platform === 'whatsapp'
                  ? customerId
                  : null,

              instagramId:
                platform === 'instagram'
                  ? customerId
                  : null,
            },
          });
      }

      // 2. Link to any upcoming booking if one exists.
      const upcomingBooking =
        await prisma.booking.findFirst({
          where: {
            customerId,
            status: {
              not: 'cancelled',
            },
            dateTime: {
              gte: new Date(),
            },
          },
          orderBy: {
            dateTime: 'asc',
          },
        });

      // 3. Create the CustomerSessionNote.
      const note =
        await prisma.customerSessionNote.create({
          data: {
            customerId,

            bookingId:
              upcomingBooking?.id || null,

            type: 'styling',

            category: 'styling',

            items: [
              analysis.outfitDescription,
            ],

            description:
              analysis.photographerNotes ||
              analysis.outfitDescription,

            status: 'pending',

            priority: 'normal',

            actionStatus: 'open',

            structuredData: {
              outfitDescription:
                analysis.outfitDescription,

              category:
                analysis.category,

              primaryColor:
                analysis.primaryColor,

              styleDetails:
                analysis.styleDetails,

              isInStudioWardrobeStyle:
                analysis.isInStudioWardrobeStyle,

              isStudioPiece:
                analysis.isStudioPiece,

              matchedStudioItemName:
                analysis.matchedStudioItemName ||
                null,

              customerIntent:
                analysis.customerIntent,

              customerReply:
                analysis.customerReply,

              clientCaption:
                caption || null,
            },

            sourceMessage:
              sourceMessage ||
              (caption
                ? `[Photo: "${caption}"]`
                : '[Shared outfit photo]'),

            platform,
          },
        });

      // 4. Update CustomerMemory key insights if available.
      try {
        const memory =
          await prisma.customerMemory.findUnique({
            where: {
              customerId,
            },
          });

        /*
         * IMPORTANT:
         *
         * Confirmed studio piece:
         *   Store as a selected studio look.
         *
         * Unconfirmed visual match:
         *   Store as inspiration/reference.
         *
         * This prevents a future AI agent from reading
         * "Selected Studio Gown" when the customer only
         * shared a Pinterest-style reference.
         */
        const newInsight =
          analysis.isStudioPiece
            ? `Selected Studio Gown: ${
                analysis.matchedStudioItemName ||
                analysis.outfitDescription
              }. Confirmed as an in-house studio wardrobe piece.`
            : `Styling reference: ${
                analysis.outfitDescription
              } (${analysis.primaryColor}). ${
                analysis.isInStudioWardrobeStyle
                  ? 'Visually similar to Fiesta House studio wardrobe styles; exact studio piece was not confirmed.'
                  : 'External inspiration or personal outfit; exact studio piece was not confirmed.'
              }`;

        if (memory) {
          const currentInsights =
            Array.isArray(memory.keyInsights)
              ? memory.keyInsights
              : [];

          if (
            !currentInsights.includes(
              newInsight
            )
          ) {
            await prisma.customerMemory.update({
              where: {
                customerId,
              },

              data: {
                keyInsights: [
                  ...currentInsights,
                  newInsight,
                ],

                lastInteractionSummary:
                  `Shared outfit reference: ${analysis.outfitDescription}`,
              },
            });
          }
        }
      } catch (memErr) {
        console.warn(
          '[VisionService] Non-critical error updating customer memory:',
          memErr
        );
      }

      return note;
    } catch (error: any) {
      console.error(
        '[VisionService] Error saving CustomerSessionNote:',
        error
      );

      throw error;
    }
  }

  /**
   * Main entrypoint:
   *
   * 1. Downloads image
   * 2. Runs vision
   * 3. Applies business safeguards
   * 4. Saves styling note
   * 5. Returns safe customer response
   */
  async handleIncomingImage(
    params: HandleImageParams
  ): Promise<string> {
    const {
      platform,
      customerId,
      imageId,
      imageUrl,
      caption,
    } = params;

    let imageBuffer: Buffer | null = null;
    let mimeType = 'image/jpeg';

    // --------------------------------------------------
    // 1. DOWNLOAD IMAGE
    // --------------------------------------------------

    try {
      if (
        platform === 'whatsapp' &&
        imageId
      ) {
        console.log(
          `[VisionService] Downloading WhatsApp image mediaId=${imageId}`
        );

        const downloaded =
          await this.downloadWhatsAppMedia(
            imageId
          );

        imageBuffer =
          downloaded.buffer;

        mimeType =
          downloaded.mimeType;
      } else if (imageUrl) {
        console.log(
          `[VisionService] Downloading image from URL on ${platform}`
        );

        const downloaded =
          await this.downloadInstagramMedia(
            imageUrl
          );

        imageBuffer =
          downloaded.buffer;

        mimeType =
          downloaded.mimeType;
      }
    } catch (downloadError: any) {
      console.error(
        `[VisionService] Failed to download image on ${platform}:`,
        downloadError.message
      );
    }

    // --------------------------------------------------
    // 2. ANALYZE IMAGE
    // --------------------------------------------------

    let analysis: OutfitAnalysisResult;

    if (imageBuffer) {
      try {
        console.log(
          `[VisionService] Running AI vision analysis for customer ${customerId}...`
        );

        analysis =
          await this.analyzeOutfitImage(
            imageBuffer,
            mimeType,
            caption,
            platform
          );

        console.log(
          `[VisionService] Vision result: ` +
            `studioPiece=${analysis.isStudioPiece}, ` +
            `styleMatch=${analysis.isInStudioWardrobeStyle}, ` +
            `matched=${analysis.matchedStudioItemName || 'none'}`
        );
      } catch (analysisError: any) {
        console.error(
          '[VisionService] AI vision analysis failed:',
          analysisError.message
        );

        analysis =
          this.createFallbackResult(
            caption
          );
      }
    } else {
      analysis =
        this.createFallbackResult(
          caption
        );
    }

    // --------------------------------------------------
    // 3. PERSIST TO DATABASE
    // --------------------------------------------------

    try {
      await this.saveStylingNote({
        customerId,
        analysis,
        platform,
        sourceMessage:
          caption
            ? `[Photo: "${caption}"]`
            : '[Shared outfit photo]',
        caption,
      });

      console.log(
        `[VisionService] Saved styling note for customer ${customerId}: "${analysis.outfitDescription}"`
      );
    } catch (saveError: any) {
      console.error(
        '[VisionService] Failed to persist styling note:',
        saveError.message
      );
    }

    // --------------------------------------------------
    // 4. RETURN SAFE CUSTOMER RESPONSE
    // --------------------------------------------------

    return analysis.customerReply;
  }
}

export const visionService =
  new VisionService();