from redbot.core import commands
from discord.ext.commands import Context

class VoiceBridge(commands.Cog):
    """Allows the AI voice bot to trigger Audio cog commands."""

    AI_BOT_ID = 1234567890 #YOUR DISCORD BOT ID

    def __init__(self, bot):
        self.bot = bot

    @commands.Cog.listener()
    async def on_message(self, message):
        # Only allow our specific AI voice bot through
        if message.author.id != self.AI_BOT_ID:
            return

        # Only handle !play commands
        if not message.content.lower().startswith("!play"):
            return

        # Parse the query
        query = message.content[len("!play"):].strip()
        if not query:
            return

        # Get the Audio cog
        audio_cog = self.bot.get_cog("Audio")
        if audio_cog is None:
            return

        # Build a context from the bot message
        ctx = await self.bot.get_context(message)
        if ctx is None:
            return

        # Invoke the play command
        try:
            await ctx.invoke(audio_cog.command_play, query=query)
        except Exception as e:
            print(f"[VoiceBridge] Error invoking play: {e}")
