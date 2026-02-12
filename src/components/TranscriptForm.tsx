import { useState } from "react";
import { Search, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface TranscriptFormProps {
  onSubmit: (url: string) => void;
  isLoading: boolean;
}

const TranscriptForm = ({ onSubmit, isLoading }: TranscriptFormProps) => {
  const [url, setUrl] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (url.trim()) {
      onSubmit(url.trim());
    }
  };

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-2xl mx-auto">
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
          <Input
            type="url"
            placeholder="Paste YouTube URL here..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="pl-12 h-14 text-base rounded-xl border-2 border-border bg-card focus:border-primary transition-colors"
            required
          />
        </div>
        <Button
          type="submit"
          disabled={isLoading || !url.trim()}
          className="h-14 px-8 text-base font-semibold rounded-xl bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
        >
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Extracting...
            </>
          ) : (
            "Generate Transcript"
          )}
        </Button>
      </div>
    </form>
  );
};

export default TranscriptForm;
