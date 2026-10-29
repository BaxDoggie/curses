import { IServiceInterface, ServiceNetworkState, TextEvent, TextEventSource, TextEventType } from "@/types";
import { WordReplacementsCache, buildWordReplacementsCache } from "@/utils";
import { toast } from "react-toastify";
import { proxy } from "valtio";
import { subscribeKey } from "valtio/utils";
import { STT_Backends } from "./schema";
import { STT_AzureService } from "./services/azure";
import { STT_DeepgramService } from "./services/deepgram";
import { STT_NativeService } from "./services/native";
import { STT_SpeechlyService } from "./services/speechly";
import {invoke} from "@tauri-apps/api/tauri";
import {
  ISTTReceiver,
  ISTTServiceConstructor,
  ISpeechRecognitionService,
  SttMuteState
} from "./types";

const backends: {
  [k in STT_Backends]?: ISTTServiceConstructor;
} = {
  [STT_Backends.native]: STT_NativeService,
  [STT_Backends.browser]: undefined,
  [STT_Backends.azure]: STT_AzureService,
  [STT_Backends.deepgram]: STT_DeepgramService,
  [STT_Backends.speechly]: STT_SpeechlyService
};

class Service_STT implements IServiceInterface, ISTTReceiver {
  #serviceInstance?: ISpeechRecognitionService;
  #lastMessageState = {
    value: "",
    isInterim: false
  }

  #_wordReplacementsCache!: WordReplacementsCache;

  updateLastMessage(value: string, isInterim: boolean) {
    this.#lastMessageState = {value, isInterim};
  }

  serviceState = proxy({
    status: ServiceNetworkState.disconnected,
    error: "",
    muted: SttMuteState.unmuted
  });

  #pushToTalkHeld = false;
  #pushToTalkEpoch = 0;

  isMuted() {
    if (this.data.pushToTalk)
      return !this.#pushToTalkHeld;
    return this.serviceState.muted === SttMuteState.muted || this.serviceState.muted === SttMuteState.pendingUnmute;
  }

  get data() {
    return window.ApiServer.state.services.stt.data;
  }

  stop(): void {
    this.#pushToTalkHeld = false;
    this.#pushToTalkEpoch++;
    window.ApiServer.keyboard.stopPushToTalk();
    this.#serviceInstance?.stop();
    this.tryCancelSentence(this.data.pushToTalk);
    if (this.data.pushToTalk)
      this.serviceState.muted = SttMuteState.muted;
  }

  setPushToTalkHeld(held: boolean) {
    if (!this.data.pushToTalk || this.#pushToTalkHeld === held)
      return;

    if (held) {
      this.tryCancelSentence();
      this.#pushToTalkEpoch++;
      this.#pushToTalkHeld = true;
      this.serviceState.muted = SttMuteState.unmuted;
    } else {
      this.#pushToTalkHeld = false;
      this.#pushToTalkEpoch++;
      this.tryCancelSentence(true);
      this.serviceState.muted = SttMuteState.muted;
    }
  }

  toggleMute() {
    if (this.data.pushToTalk)
      return;

    if (this.serviceState.muted === SttMuteState.unmuted) {
      // cancel mid sentence and notify user
      this.tryCancelSentence();
      this.serviceState.muted = SttMuteState.muted;
    }
    else if (this.serviceState.muted === SttMuteState.muted){
      // set pending if unmuting during interim results
      if (this.#lastMessageState.isInterim) {
        this.serviceState.muted = SttMuteState.pendingUnmute;
      }
      else {
        this.serviceState.muted = SttMuteState.unmuted;
      }
    }
    else 
      this.serviceState.muted = SttMuteState.unmuted;
  }

  triggerPendingUnmute() {
    // apply unmute if pending
    if (this.serviceState.muted === SttMuteState.pendingUnmute) {
      this.serviceState.muted = SttMuteState.unmuted;
    }
  }

  updateReplacementsCache() {
    this.#_wordReplacementsCache = buildWordReplacementsCache(this.data.replaceWords, this.data.replaceWordsIgnoreCase);
  }

  runReplacements(value: string) {
    if (this.#_wordReplacementsCache.isEmpty)
      return value;
    return value.replace(this.#_wordReplacementsCache.regexp, v => {
      if (this.data.replaceWordsIgnoreCase) {
        let _v = v.toLowerCase();
        if (this.data.replaceWordsPreserveCase) {
          const isUppercase = v[0] === v[0].toUpperCase();
          let replacement = this.#_wordReplacementsCache.map[_v];
          
          const vCase = isUppercase ? replacement[0].toUpperCase() : replacement[0].toLowerCase();
          replacement = vCase + replacement.slice(1);
          return replacement;
        }
        else {
          return this.#_wordReplacementsCache.map[_v];
        }
      }

      let _v = this.data.replaceWordsIgnoreCase ? v.toLowerCase() : v;
      return this.#_wordReplacementsCache.map[_v];
    });
  }

  async init() {
    this.updateReplacementsCache();
    subscribeKey(this.data, "replaceWords", () => this.updateReplacementsCache());
    subscribeKey(this.data, "replaceWordsIgnoreCase", () => this.updateReplacementsCache());

    window.ApiShared.pubsub.subscribe("stream.on_ended", () => {
      if (this.data.stopWithStream && this.serviceState.status === ServiceNetworkState.connected) {
        this.stop();
      }
    });
    
    // native is bugged
    if (this.data.autoStart && this.data.backend !== STT_Backends.native)
      this.start();
  }

  tryCancelSentence(forcePublish = false) {
    if (this.#lastMessageState.isInterim) {
      this.#sendFinal("[...]", forcePublish);
      this.updateLastMessage("", false);
    }
  }

  processExternalMessage(event: Partial<TextEvent>) {
    if (!("type" in event) || !event.value)
      return;
    if (event.type === TextEventType.final)
      this.#sendFinal(event.value);
    else
      this.#sendInterim(event.value);
  }

  async #sendFinal(sentence: string, forcePublish = false) {
    const pushToTalkEpoch = this.#pushToTalkEpoch;
    let value = sentence;
    if (this.data.uwu) {
      value = await invoke<string>("plugin:uwu|translate", {value: sentence});
    }

    value = this.runReplacements(value);
    const isCurrentPushToTalkCapture = forcePublish || !this.data.pushToTalk || (pushToTalkEpoch === this.#pushToTalkEpoch && this.#pushToTalkHeld);
    isCurrentPushToTalkCapture && (forcePublish || !this.isMuted()) &&
    window.ApiShared.pubsub.publishText(TextEventSource.stt, {
      value,
      type: TextEventType.final,
    });

    isCurrentPushToTalkCapture && this.updateLastMessage(value, false);

    // apply unmute if pending
    isCurrentPushToTalkCapture && this.triggerPendingUnmute();
  }

  async #sendInterim(sentence: string) {
    const pushToTalkEpoch = this.#pushToTalkEpoch;
    let value = sentence;
    if (this.data.uwu) {
      value = await invoke<string>("plugin:uwu|translate", {value: sentence});
    }
    value = this.runReplacements(value);
    const isCurrentPushToTalkCapture = !this.data.pushToTalk || (pushToTalkEpoch === this.#pushToTalkEpoch && this.#pushToTalkHeld);
    isCurrentPushToTalkCapture && !this.isMuted() &&
    window.ApiShared.pubsub.publishText(TextEventSource.stt, {
      value,
      type: TextEventType.interim,
    });
    isCurrentPushToTalkCapture && this.updateLastMessage(value, true);
  }

  #setStatus(value: ServiceNetworkState) {
    this.serviceState.status = value;
  }

  onStart(): void {
    this.#setStatus(ServiceNetworkState.connected);
  }
  onStop(error?: string | undefined): void {
    if (error && this.data.pushToTalk) {
      this.#pushToTalkHeld = false;
      this.#pushToTalkEpoch++;
      this.serviceState.muted = SttMuteState.muted;
      window.ApiServer.keyboard.stopPushToTalk();
    }

    if (error) {
      toast(error, { type: "error", autoClose: false });
      this.serviceState.error = error;
    }
    this.#setStatus(ServiceNetworkState.disconnected);
  }
  onInterim(value: string): void {
    this.#sendInterim(value);
  }
  onFinal(value: string): void {
    this.#sendFinal(value);
  }

  async start() {
    this.stop();
    this.serviceState.error = "";

    let backend = this.data.backend;
    if (!(backend in backends) || !backends[backend]) {
      return;
    }

    if (this.data.pushToTalk) {
      if (!this.data.pushToTalkKey) {
        const error = "Choose a push-to-talk key before starting speech-to-text";
        this.serviceState.error = error;
        toast.error(error);
        return;
      }

      this.serviceState.muted = SttMuteState.muted;
      try {
        await window.ApiServer.keyboard.startPushToTalk(this.data.pushToTalkKey);
      } catch (error) {
        this.serviceState.error = String(error);
        toast.error(`Could not start push-to-talk: ${error}`);
        this.stop();
        return;
      }
    }

    const serviceConstructor = backends[backend];
    if (!serviceConstructor)
      return;
    this.#serviceInstance = new serviceConstructor(this);
    this.#setStatus(ServiceNetworkState.connecting);
    this.#serviceInstance.start(this.data);
  }
}

export default Service_STT;
