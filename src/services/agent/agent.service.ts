
import OpenAI from 'openai';
import { knowledgeRetrieval } from '../knowledge/retrieval.service';
import prisma from '../../config/prisma';
import dayjs from 'dayjs';
import { bookingService } from '../booking/booking.service';
import { googleCalendarService } from '../calendar/calendar.service';
import { SERVICE_DURATIONS, DEFAULT_DURATION } from '../../config/constants';

// Ensure you have OPENAI_API_KEY in your .env
const openai = new OpenAI();

// --- Hybrid Booking Extractor ---
type BookingDetails = {
  name?: string | null;
  service?: string | null;
  date?: string | null;
  time?: string | null;
};

export class BookingExtractor {
  // 🧼 STEP 1: Clean Input
  private clean(text: string): string {
    return text
      .replace(/[^ 0-\w\s]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  // ⚡ STEP 2: Regex Extraction
  private regexExtract(text: string): BookingDetails {
    const cleanText = this.clean(text);

    // Don't extract names from short greetings
    if (cleanText.length < 10) return { name: null, service: null, date: null, time: null };

    // Look for patterns like "my name is..." or "this is..."
    const nameMatch = cleanText.match(/my name is ([a-z]{2,})/i) || 
                      cleanText.match(/this is ([a-z]{2,})/i) ||
                      cleanText.match(/i am ([a-z]{2,})/i);
    
    const serviceMatch = cleanText.match(/(standard|economy|executive|gold|platinum|vip|vvip)\s+package/i);
    const dateMatch = cleanText.match(/(\d{1,2})(st|nd|rd|th)?/i);
    const timeMatch = cleanText.match(/(\d{1,2})(:|\s*)(\d{2})?\s*(am|pm)/i);

    let date;
    let time = null;

    if (timeMatch) {
      time = timeMatch[0].toLowerCase().replace(/\s/g, '');
    }
    if (dateMatch) {
      const day = dateMatch[1];
      const parsed = dayjs().date(Number(day));
      if (parsed.isValid()) {
        date = parsed.format('YYYY-MM-DD');
      }
    }

    return {
      name: nameMatch?.[1] || null,
      service: serviceMatch?.[1] || null,
      date: date || null,
      time: time || null
    };
  }

  // 🤖 STEP 3: AI Extraction (STRICT JSON)
  private async aiExtract(message: string): Promise<BookingDetails> {
    const now = dayjs().format('dddd, MMMM D, YYYY h:mm A');
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Current Date/Time: ${now}\n\nExtract booking details from the user message.\n\nReturn ONLY valid JSON. No text.\n\nFormat:\n{\n  "name": string | null,\n  "service": string | null,\n  "date": string | null,\n  "time": string | null\n}\n\nRules:\n- Name must be full name if possible
- Service must be one of: standard, economy, executive, gold, platinum, vip, vvip
- Convert date into YYYY-MM-DD
- Convert time into 24h format (HH:mm)
- If missing, return null
`
        },
        { role: 'user', content: message }
      ],
      temperature: 0
    });
    try {
      return JSON.parse(response.choices[0].message.content || '{}');
    } catch {
      return {};
    }
  }

  // 🔥 FINAL HYBRID METHOD
  async extract(message: string): Promise<BookingDetails> {
    const regex = this.regexExtract(message);
    console.log('Regex result:', regex);
    if (regex.name && regex.service && regex.date && regex.time) {
      return regex;
    }
    const ai = await this.aiExtract(message);
    console.log('AI result:', ai);
    return {
      name: regex.name || ai.name,
      service: regex.service || ai.service,
      date: regex.date || ai.date,
      time: regex.time || ai.time
    };
  }
}


export class AgentService {
  private getSystemPrompt(businessContext: string, platform: string): string {
    const now = dayjs().format('dddd, MMMM D, YYYY h:mm A');
    return `Current Date/Time: ${now}
You are the official AI assistant for Fiesta House Attire & Maternity.
Your goal is to answer customer questions accurately and help them make bookings.

Business Context and Customer History:
${businessContext}

Instructions:
1. Be friendly, empathetic, and professional.
2. If you know the customer's name, greet them by name. If the name is "Unknown", ask for it when they want to book.
3. If the customer asks about their past sessions or bookings, use the "Past Bookings" information provided above.
4. If a customer asks a question, answer it using ONLY the provided Business Context.
5. PLATFORM RESTRICTIONS: You are currently talking to the user on "${platform}". If the platform is "instagram" or "facebook", YOU CANNOT MAKE BOOKINGS. If a user wants to book, politely tell them that bookings are only accepted via WhatsApp, and instruct them to click the WhatsApp link/button on our profile to continue.
6. If the platform IS "whatsapp" or "web", and they want to book, guide them through it. Gather their Name, the Service they want, a Date, and a Time.
7. If they want to RESCHEDULE an existing booking, use the 'reschedule_booking' tool.
8. If the customer mentions a specific detail about their session (e.g. "I'm bringing my family", "I want a blue backdrop"), use the 'add_session_note' tool to save it.
9. IMPORTANT: Never assume or make up a time. If the user doesn't provide a time, YOU MUST ASK for it.
10. Before confirming, ALWAYS call 'get_available_slots' for the specific date and service to see which times are free.
11. If the user's preferred time is taken, suggest the closest available slots from the list returned by 'get_available_slots'.
12. Once you have the Name, Service, Date, and Time, and you've verified the slot is free, use 'make_booking' to finalize.
13. Do NOT ask for payment or a deposit. Bookings are finalized without an upfront payment step.
14. We are CLOSED on Mondays. Do NOT allow any bookings on Mondays.
15. If the context doesn't answer their question, politely let them know you'll have a human team member follow up.
16. KEEP RESPONSES CONCISE: Messages on some platforms have length limits. Do not send walls of text. Keep your responses under 800 characters if possible.`;
  }

  /**
   * Handles an incoming message from a customer, with conversation history.
   */
  async handleMessage(customerId: string, userMessage: string, history: { role: 'user'|'assistant', content: string }[] = [], platform: string = 'whatsapp') {
    // 1. Fetch Customer and Booking History for Memory
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      include: { bookings: { orderBy: { dateTime: 'desc' }, take: 5 } }
    });

    const customerName = customer?.name && customer.name !== 'WhatsApp User' ? customer.name : 'Unknown';
    const pastBookings = customer?.bookings.map(b => 
      `${b.service} on ${dayjs(b.dateTime).format('YYYY-MM-DD')} (${b.status})`
    ).join(', ') || 'No past bookings';

    // 2. Retrieve RAG Context
    const relevantKnowledge = await knowledgeRetrieval.search(userMessage, 10);
    const contextString = relevantKnowledge.map(k => k.content).join('\n---\n');

    const fullContext = `Customer Phone: ${customerId}
Customer Name: ${customerName}
Past Bookings: ${pastBookings}

Business Context:
${contextString}`;

    // 3. Build conversation history
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: this.getSystemPrompt(fullContext, platform) },
      ...history,
      { role: 'user', content: userMessage }
    ];

    // 3. Hybrid Extraction (for logging/debug, we'll let LLM handle the tool calls)
    const extractor = new BookingExtractor();
    const extracted = await extractor.extract(userMessage);
    console.log('Extracted details:', extracted);

    // 4. Define the tools the AI can use
    const allTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
      {
        type: 'function',
        function: {
          name: 'add_session_note',
          description: 'Saves a note about a specific request or detail for a booking (e.g. "bringing husband", "special backdrop request").',
          parameters: {
            type: 'object',
            properties: {
              bookingDate: { type: 'string', description: 'The date of the booking this note applies to (YYYY-MM-DD)' },
              note: { type: 'string', description: 'The specific detail to save' },
              type: { type: 'string', enum: ['external_people', 'external_items', 'special_request', 'other'], description: 'Category of the note' }
            },
            required: ['bookingDate', 'note', 'type']
          }
        }
      }
    ];

    if (platform === 'whatsapp' || platform === 'web') {
      allTools.push(
        {
          type: 'function',
          function: {
            name: 'make_booking',
            description: 'Finalizes a booking for a customer.',
            parameters: {
              type: 'object',
              properties: {
                customerName: { type: 'string', description: 'The full name of the customer' },
                service: { type: 'string', description: 'The photography or attire service requested' },
                date: { type: 'string', description: 'The date for the booking (YYYY-MM-DD)' },
                time: { type: 'string', description: 'The time for the booking (HH:mm)' }
              },
              required: ['customerName', 'service', 'date', 'time']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'reschedule_booking',
            description: 'Reschedules an existing upcoming booking to a new date and time.',
            parameters: {
              type: 'object',
              properties: {
                newDate: { type: 'string', description: 'The new date for the booking (YYYY-MM-DD)' },
                newTime: { type: 'string', description: 'The new time for the booking (HH:mm)' }
              },
              required: ['newDate', 'newTime']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'get_available_slots',
            description: 'Check available time slots for a specific date and service duration',
            parameters: {
              type: 'object',
              properties: {
                date: { type: 'string', description: 'The date to check (YYYY-MM-DD)' },
                service: { type: 'string', description: 'The service name (to determine duration)' }
              },
              required: ['date', 'service']
            }
          }
        }
      );
    }

    // 5. Call LLM
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      tools: allTools,
      tool_choice: 'auto'
    });

    const responseMessage = response.choices[0].message;

    // 6. Handle Tool Calls
    if (responseMessage.tool_calls) {
      messages.push(responseMessage); // Add assistant message to history once

      for (const toolCall of responseMessage.tool_calls) {
        if (toolCall.type === 'function') {
          const functionName = toolCall.function.name;
          const args = JSON.parse(toolCall.function.arguments);
          let toolResponse: string;

          console.log(`Tool Called: ${functionName} with args:`, args);

          try {
            if (functionName === 'make_booking') {
              await this.executeBookingTool(customerId, args.customerName, args.service, `${args.date}T${args.time}`);
              toolResponse = `SUCCESS: Booking confirmed for ${args.customerName} on ${args.date} at ${args.time}.`;
            } 
            else if (functionName === 'reschedule_booking') {
              const success = await this.executeRescheduleTool(customerId, args.newDate, args.newTime);
              toolResponse = success 
                ? `SUCCESS: Booking rescheduled to ${args.newDate} at ${args.newTime}.`
                : `ERROR: No upcoming booking found to reschedule.`;
            } 
            else if (functionName === 'add_session_note') {
              await this.executeAddNoteTool(customerId, args.bookingDate, args.note, args.type);
              toolResponse = `SUCCESS: Note added to session on ${args.bookingDate}.`;
            } 
            else if (functionName === 'get_available_slots') {
              const serviceKey = Object.keys(SERVICE_DURATIONS).find(k => args.service.toLowerCase().includes(k)) || 'standard';
              const duration = SERVICE_DURATIONS[serviceKey] || DEFAULT_DURATION;
              const result: any = await bookingService.getAvailableSlots(args.date, duration);
              
              if (result.status === 'closed') {
                toolResponse = `The business is CLOSED on ${args.date} because: ${result.reason}.`;
              } else {
                const slots = Array.isArray(result) ? result : [];
                toolResponse = `Available slots for ${args.service} on ${args.date}: ${slots.length > 0 ? slots.join(', ') : 'None'}.`;
              }
            } else {
              toolResponse = `ERROR: Tool ${functionName} not found.`;
            }
          } catch (e: any) {
            console.error(`Tool execution error (${functionName}):`, e);
            toolResponse = `ERROR: ${e.message}`;
          }

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResponse
          });
        }
      }

      // After all tools are handled, get the final AI response
      const secondResponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        tools: allTools
      });

      return secondResponse.choices[0].message.content || 'I have processed your request.';
    }

    // 7. Return normal text response
    return responseMessage.content || "I'm sorry, I couldn't process that.";
  }

  /**
   * Database Logic to execute the booking without payment
   */
  private async executeBookingTool(customerId: string, name: string, service: string, date: string) {
    let customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) {
       customer = await prisma.customer.create({
           data: { id: customerId, name: name }
       });
    } else if (customer.name !== name) {
       await prisma.customer.update({ where: { id: customerId }, data: { name }});
    }

    const serviceKey = Object.keys(SERVICE_DURATIONS).find(k => service.toLowerCase().includes(k)) || 'standard';
    const duration = SERVICE_DURATIONS[serviceKey] || DEFAULT_DURATION;

    // Create the confirmed booking
    const booking = await prisma.booking.create({
      data: {
        customerId: customer.id,
        service: service,
        dateTime: new Date(date),
        status: 'confirmed',
        durationMinutes: duration
      }
    });

    // Sync with Google Calendar
    const googleEventId = await googleCalendarService.createEvent({
      service: service,
      dateTime: new Date(date),
      customerName: name,
      durationMinutes: duration
    });

    if (googleEventId) {
      await prisma.booking.update({
        where: { id: booking.id },
        data: { googleEventId }
      });
    }
  }

  /**
   * Logic to reschedule an upcoming booking
   */
  private async executeRescheduleTool(customerId: string, newDate: string, newTime: string) {
    // Find the nearest upcoming confirmed booking
    const upcomingBooking = await prisma.booking.findFirst({
      where: {
        customerId: customerId,
        status: 'confirmed',
        dateTime: {
          gte: new Date()
        }
      },
      include: { customer: true },
      orderBy: {
        dateTime: 'asc'
      }
    });

    if (!upcomingBooking) return false;

    const newDateTime = new Date(`${newDate}T${newTime}`);

    // Update the booking
    await prisma.booking.update({
      where: { id: upcomingBooking.id },
      data: {
        dateTime: newDateTime
      }
    });

    // Update Google Calendar
    if (upcomingBooking.googleEventId) {
      const serviceKey = Object.keys(SERVICE_DURATIONS).find(k => upcomingBooking.service.toLowerCase().includes(k)) || 'standard';
      const duration = SERVICE_DURATIONS[serviceKey] || DEFAULT_DURATION;

      await googleCalendarService.updateEvent(upcomingBooking.googleEventId, {
        service: upcomingBooking.service,
        dateTime: newDateTime,
        customerName: upcomingBooking.customer.name,
        durationMinutes: duration
      });
    }

    return true;
  }

  /**
   * Logic to save a note for a customer session
   */
  private async executeAddNoteTool(customerId: string, bookingDate: string, note: string, type: string) {
    // Try to find the booking for this date
    const booking = await prisma.booking.findFirst({
      where: {
        customerId: customerId,
        dateTime: {
          gte: new Date(`${bookingDate}T00:00:00`),
          lte: new Date(`${bookingDate}T23:59:59`)
        }
      }
    });

    await prisma.customerSessionNote.create({
      data: {
        customerId: customerId,
        bookingId: booking?.id,
        description: note,
        type: type,
        status: 'pending'
      }
    });
  }
}

export const agentService = new AgentService();
