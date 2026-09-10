<!-- TTS via Web Speech API - Integração com OpenLive -->
<script>
/**
 * TTS usando Web Speech API do navegador (Chrome/Edge)
 * Vozes em português brasileiro: pt-BR-FranciscaNeural, pt-BR-AntonioNeural
 * Roda 100% local, sem API key, sem servidor adicional
 */

const TTS = {
  voice: null,
  synth: window.speechSynthesis,
  speaking: false,
  queue: [],

  async init() {
    // Esperar vozes carregarem
    await new Promise(resolve => {
      if (this.synth.getVoices().length > 0) return resolve();
      this.synth.onvoiceschanged = () => resolve();
    });

    // Encontrar voz em português
    const voices = this.synth.getVoices();
    console.log('[TTS] Vozes disponiveis:', voices.map(v => v.name).join(', '));

    // Preferir voz neural em português
    this.voice = voices.find(v =>
      v.lang.startsWith('pt-BR') &&
      (v.name.includes('Neural') || v.name.includes('Francisca') || v.name.includes('Antonio'))
    ) || voices.find(v => v.lang.startsWith('pt-BR')) ||
      voices.find(v => v.lang.startsWith('pt')) ||
      voices[0]; // fallback

    console.log('[TTS] Voz selecionada:', this.voice?.name || 'nenhuma');
    return this.voice;
  },

  async speak(text, { rate = 1, pitch = 1, volume = 1 } = {}) {
    if (!this.voice) await this.init();
    if (!text || !text.trim()) return;

    return new Promise((resolve) => {
      // Cancela fala anterior se existir
      if (this.speaking) {
        this.synth.cancel();
      }

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.voice = this.voice;
      utterance.rate = rate;
      utterance.pitch = pitch;
      utterance.volume = volume;
      utterance.lang = 'pt-BR';

      utterance.onstart = () => { this.speaking = true; };
      utterance.onend = () => {
        this.speaking = false;
        resolve();
      };
      utterance.onerror = (e) => {
        console.error('[TTS] Erro:', e);
        this.speaking = false;
        resolve();
      };

      this.synth.speak(utterance);
    });
  },

  // Fala enquanto recebe texto via streaming (chunks)
  speakChunk(text) {
    if (this.queue.length === 0 && !this.speaking) {
      this._processQueue();
    }
    this.queue.push(text);
  },

  async _processQueue() {
    if (this.queue.length === 0) {
      this.speaking = false;
      return;
    }

    this.speaking = true;
    const text = this.queue.shift();
    await this.speak(text);
    // Processa proximo da fila
    setTimeout(() => this._processQueue(), 100);
  },

  cancel() {
    this.synth.cancel();
    this.speaking = false;
    this.queue = [];
  },

  // Listar vozes disponiveis (para debug)
  listVoices() {
    return this.synth.getVoices().map(v => ({
      name: v.name,
      lang: v.lang,
      localService: v.localService,
      default: v.default
    }));
  }
};

// Testar se carregou corretamente
document.addEventListener('DOMContentLoaded', () => {
  TTS.init().then(voice => {
    console.log('[TTS] Init completo. Voz:', voice?.name);
    // Se quiser testar:
    // TTS.speak('Olá! Bem-vindo à pizzaria.');
  });
});

// Export global para uso no console
window.TTS = TTS;
</script>
