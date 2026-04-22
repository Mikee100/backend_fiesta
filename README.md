# Fiesta AI Backend 2.0

Autonomous AI booking system for Fiesta House, integrated with WhatsApp, Instagram, Google Calendar, and M-Pesa.

## 🚀 Features

- **Autonomous Agent**: GPT-4o powered agent with tool-calling for bookings and information retrieval.
- **Multi-Channel**: Integrated with WhatsApp and Instagram Business APIs.
- **Smart Booking**: Bi-directional sync with Google Calendar and automated conflict detection.
- **RAG System**: Context-aware responses using Pinecone vector database.
- **Automated Workflows**: 
  - 24-hour appointment reminders.
  - 5-day post-shoot feedback follow-ups.
- **Analytics Dashboard**: Real-time reporting on revenue, customer sentiment, and popular packages.

## 🛠️ Tech Stack

- **Runtime**: Node.js with TypeScript
- **Framework**: Express.js
- **Database**: PostgreSQL with Prisma ORM
- **AI**: OpenAI (GPT-4o, Embeddings)
- **Vector DB**: Pinecone
- **Real-time**: Socket.io

## 📋 Prerequisites

- Node.js (v18+)
- PostgreSQL Database
- OpenAI API Key
- Pinecone Account
- WhatsApp Business API Credentials

## ⚙️ Setup

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd backend-2.0
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment Variables**:
   Copy `.env.example` to `.env` and fill in your credentials.
   ```bash
   cp .env.example .env
   ```

4. **Initialize Database**:
   ```bash
   npx prisma generate
   npx prisma db push
   ```

5. **Run in Development**:
   ```bash
   npm run dev
   ```

## 🤖 Automation Jobs

The system includes a background cron service that runs hourly to process:
- **Reminders**: Sent 24 hours before a confirmed booking.
- **Feedback**: Sent 5 days after a booking is completed.

## 📄 License

Internal use for Fiesta House.
