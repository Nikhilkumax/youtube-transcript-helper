import { Sparkles } from "lucide-react";

const comingSoonFeatures = [
  {
    title: "AI Enhanced Transcript",
    description: "Get AI-powered punctuation, formatting, and paragraph breaks for better readability.",
  },
  {
    title: "Summarize Transcript",
    description: "Automatically generate concise summaries of long video transcripts.",
  },
];

const ComingSoonSection = () => {
  return (
    <section className="w-full max-w-2xl mx-auto">
      <h2 className="font-heading text-2xl font-bold text-foreground text-center mb-6">
        Coming Soon
      </h2>
      <div className="grid sm:grid-cols-2 gap-4">
        {comingSoonFeatures.map((feature, index) => (
          <div
            key={index}
            className="bg-card border border-border rounded-xl p-6 opacity-70 relative overflow-hidden"
          >
            <div className="absolute top-3 right-3 bg-accent text-accent-foreground text-xs font-semibold px-2.5 py-1 rounded-full flex items-center gap-1">
              <Sparkles className="h-3 w-3" />
              Soon
            </div>
            <h3 className="font-heading font-semibold text-foreground mb-2">{feature.title}</h3>
            <p className="text-sm text-muted-foreground">{feature.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
};

export default ComingSoonSection;
