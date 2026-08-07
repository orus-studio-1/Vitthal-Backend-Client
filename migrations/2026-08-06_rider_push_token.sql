-- Add push_token column to delivery_agents table to store Expo push tokens
ALTER TABLE delivery_agents 
    ADD COLUMN IF NOT EXISTS push_token TEXT;
