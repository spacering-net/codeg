"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"
import {
  AudioLines,
  Cloud,
  Cpu,
  KeyRound,
  Languages,
  Link,
  Gauge,
  Loader2,
  Mic,
  Speaker,
  Volume2,
  Wand2,
} from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import {
  SettingsError,
  SettingsSaveBar,
  SettingsSection,
} from "@/components/shared/settings-section"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { speechGetSettings, speechUpdateSettings } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  LOCALE_TO_BCP47,
  detectSpeechCapabilities,
  resolveInputEngine,
  resolveOutputEngine,
  resolveSpeechLanguage,
  waitForVoices,
} from "@/lib/speech-capabilities"
import {
  MAX_SPEECH_RATE,
  MIN_SPEECH_RATE,
  saveSpeechPrefs,
  useSpeechPrefs,
  type SpeechEnginePreference,
} from "@/lib/speech-prefs"
import type { SpeechCloudSettings } from "@/lib/types"

const LANGUAGE_FOLLOW_APP = "follow-app"
const VOICE_DEFAULT = "default"
const LANGUAGE_CUSTOM = "custom"
const LANGUAGE_TAGS = Array.from(new Set(Object.values(LOCALE_TO_BCP47)))

const REASON_KEYS = {
  "no-mic": "reasonNoMic",
  "insecure-context": "reasonInsecure",
  "no-engine": "reasonNoEngine",
  "cloud-not-configured": "reasonCloudNotConfigured",
} as const

const OUTPUT_REASON_KEYS = {
  "no-engine": "reasonNoVoices",
  "cloud-not-configured": "reasonCloudNotConfigured",
} as const

const subscribeNever = () => () => {}
const onClient = () => true
const onServer = () => false

function languageName(tag: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(tag) ?? tag
  } catch {
    return tag
  }
}

export function SpeechSettings() {
  const t = useTranslations("SpeechSettings")
  const locale = useLocale()
  const prefs = useSpeechPrefs()

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [cloud, setCloud] = useState<SpeechCloudSettings | null>(null)
  const [apiKeySet, setApiKeySet] = useState(false)
  const [apiKeyDraft, setApiKeyDraft] = useState("")
  const [saving, setSaving] = useState(false)
  const [customLanguageMode, setCustomLanguageMode] = useState(false)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[] | null>(null)

  const mounted = useSyncExternalStore(subscribeNever, onClient, onServer)
  const caps = useMemo(
    () => (mounted ? detectSpeechCapabilities() : null),
    [mounted]
  )

  useEffect(() => {
    let alive = true
    speechGetSettings().then(
      (view) => {
        if (!alive) return
        setCloud(view.settings)
        setApiKeySet(view.apiKeySet)
        setLoading(false)
      },
      (err) => {
        if (!alive) return
        setLoadError(toErrorMessage(err))
        setLoading(false)
      }
    )
    return () => {
      alive = false
    }
  }, [])

  const input = prefs.input
  const updateInput = useCallback(
    (patch: Partial<typeof input>) => {
      saveSpeechPrefs({ input: { ...input, ...patch } })
    },
    [input]
  )

  const output = prefs.output
  const updateOutput = useCallback(
    (patch: Partial<typeof output>) => {
      saveSpeechPrefs({ output: { ...output, ...patch } })
    },
    [output]
  )

  const outputOn = output.enabled
  useEffect(() => {
    if (!outputOn) return
    let alive = true
    void waitForVoices().then((list) => {
      if (alive) setVoices(list)
    })
    return () => {
      alive = false
    }
  }, [outputOn])

  const speechLanguage = resolveSpeechLanguage(input, locale)
  const sortedVoices = useMemo(() => {
    if (!voices) return []
    const base = speechLanguage.toLowerCase().split("-")[0]
    const matches = (voice: SpeechSynthesisVoice) =>
      voice.lang.toLowerCase().split("-")[0] === base
    return [
      ...voices.filter(matches),
      ...voices.filter((voice) => !matches(voice)),
    ]
  }, [speechLanguage, voices])

  const outputStatus = useMemo(() => {
    if (voices === null) return null
    const resolution = resolveOutputEngine(
      output,
      { browserTts: voices.length > 0 },
      apiKeySet
    )
    if (resolution.engine === null) {
      return t(OUTPUT_REASON_KEYS[resolution.reason])
    }
    return t("engineUsing", {
      engine: t(
        resolution.engine === "browser" ? "engineBrowser" : "engineCloud"
      ),
    })
  }, [apiKeySet, output, t, voices])

  const engineStatus = useMemo(() => {
    if (!caps) return null
    const resolution = resolveInputEngine(input, caps, apiKeySet)
    if (resolution.engine === null) {
      return t(REASON_KEYS[resolution.reason])
    }
    return t("engineUsing", {
      engine: t(
        resolution.engine === "browser" ? "engineBrowser" : "engineCloud"
      ),
    })
  }, [apiKeySet, caps, input, t])

  const languageSelection =
    customLanguageMode ||
    (input.language !== "" && !LANGUAGE_TAGS.includes(input.language))
      ? LANGUAGE_CUSTOM
      : input.language || LANGUAGE_FOLLOW_APP

  const onLanguageSelect = useCallback(
    (value: string) => {
      if (value === LANGUAGE_CUSTOM) {
        setCustomLanguageMode(true)
        return
      }
      setCustomLanguageMode(false)
      updateInput({ language: value === LANGUAGE_FOLLOW_APP ? "" : value })
    },
    [updateInput]
  )

  const persistCloud = useCallback(
    async (apiKey: string | null, successMessage: string) => {
      if (!cloud) return
      setSaving(true)
      try {
        const view = await speechUpdateSettings(cloud, apiKey)
        setCloud(view.settings)
        setApiKeySet(view.apiKeySet)
        setApiKeyDraft("")
        toast.success(successMessage)
      } catch (err) {
        toast.error(t("saveFailed", { message: toErrorMessage(err) }))
      } finally {
        setSaving(false)
      }
    },
    [cloud, t]
  )

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("loading")}
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="w-full space-y-4 p-3 md:p-4">
        <section className="space-y-1">
          <h1 className="text-sm font-semibold">{t("sectionTitle")}</h1>
          <p className="text-xs text-muted-foreground">
            {t("sectionDescription")}
          </p>
        </section>

        <SettingsSection
          icon={Mic}
          title={t("inputTitle")}
          description={t("inputDescription")}
          htmlFor="speech-input-enabled"
          control={
            <Switch
              id="speech-input-enabled"
              aria-label={t("inputTitle")}
              checked={input.enabled}
              onCheckedChange={(enabled) => updateInput({ enabled })}
            />
          }
        >
          {input.enabled && (
            <SettingCard>
              <SettingRow
                icon={Cpu}
                title={t("engineLabel")}
                description={
                  engineStatus ? (
                    <span data-testid="speech-engine-status">
                      {engineStatus}
                    </span>
                  ) : undefined
                }
                htmlFor="speech-input-engine"
                control={
                  <Select
                    value={input.engine}
                    onValueChange={(engine) =>
                      updateInput({ engine: engine as SpeechEnginePreference })
                    }
                  >
                    <SelectTrigger
                      id="speech-input-engine"
                      size="sm"
                      className="w-40 bg-background text-xs"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end">
                      <SelectItem value="auto">{t("engineAuto")}</SelectItem>
                      <SelectItem value="browser">
                        {t("engineBrowser")}
                      </SelectItem>
                      <SelectItem value="cloud">{t("engineCloud")}</SelectItem>
                    </SelectContent>
                  </Select>
                }
              />
              <SettingRow
                icon={Languages}
                title={t("languageLabel")}
                description={t("languageDescription")}
                htmlFor="speech-input-language"
                control={
                  <Select
                    value={languageSelection}
                    onValueChange={onLanguageSelect}
                  >
                    <SelectTrigger
                      id="speech-input-language"
                      size="sm"
                      className="w-48 bg-background text-xs"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end">
                      <SelectItem value={LANGUAGE_FOLLOW_APP}>
                        {t("languageFollowApp")}
                      </SelectItem>
                      {LANGUAGE_TAGS.map((tag) => (
                        <SelectItem key={tag} value={tag}>
                          {languageName(tag, locale)}
                        </SelectItem>
                      ))}
                      <SelectItem value={LANGUAGE_CUSTOM}>
                        {t("languageCustom")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                }
              >
                {languageSelection === LANGUAGE_CUSTOM && (
                  <Input
                    aria-label={t("languageCustom")}
                    className="h-8 text-xs"
                    value={input.language}
                    placeholder={t("languageCustomPlaceholder")}
                    onChange={(e) =>
                      updateInput({ language: e.target.value.trim() })
                    }
                    spellCheck={false}
                  />
                )}
              </SettingRow>
            </SettingCard>
          )}
        </SettingsSection>

        <SettingsSection
          icon={Volume2}
          title={t("outputTitle")}
          description={t("outputDescription")}
          htmlFor="speech-output-enabled"
          control={
            <Switch
              id="speech-output-enabled"
              aria-label={t("outputTitle")}
              checked={output.enabled}
              onCheckedChange={(enabled) =>
                updateOutput(
                  enabled ? { enabled } : { enabled, autoRead: false }
                )
              }
            />
          }
        >
          {output.enabled && (
            <SettingCard>
              <SettingRow
                icon={Cpu}
                title={t("outputEngineLabel")}
                description={
                  outputStatus ? (
                    <span data-testid="speech-output-status">
                      {outputStatus}
                    </span>
                  ) : undefined
                }
                htmlFor="speech-output-engine"
                control={
                  <Select
                    value={output.engine}
                    onValueChange={(engine) =>
                      updateOutput({ engine: engine as SpeechEnginePreference })
                    }
                  >
                    <SelectTrigger
                      id="speech-output-engine"
                      size="sm"
                      className="w-40 bg-background text-xs"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end">
                      <SelectItem value="auto">{t("engineAuto")}</SelectItem>
                      <SelectItem value="browser">
                        {t("engineBrowser")}
                      </SelectItem>
                      <SelectItem value="cloud">{t("engineCloud")}</SelectItem>
                    </SelectContent>
                  </Select>
                }
              />
              {output.engine !== "cloud" && sortedVoices.length > 0 && (
                <SettingRow
                  icon={Speaker}
                  title={t("voiceLabel")}
                  htmlFor="speech-output-voice"
                  control={
                    <Select
                      value={output.browserVoiceUri || VOICE_DEFAULT}
                      onValueChange={(uri) =>
                        updateOutput({
                          browserVoiceUri: uri === VOICE_DEFAULT ? "" : uri,
                        })
                      }
                    >
                      <SelectTrigger
                        id="speech-output-voice"
                        size="sm"
                        className="w-48 bg-background text-xs"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent align="end">
                        <SelectItem value={VOICE_DEFAULT}>
                          {t("voiceDefault")}
                        </SelectItem>
                        {sortedVoices.map((voice) => (
                          <SelectItem
                            key={voice.voiceURI}
                            value={voice.voiceURI}
                          >
                            {voice.name} ({voice.lang})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  }
                />
              )}
              <SettingRow
                icon={Gauge}
                title={t("rateLabel")}
                control={
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {output.rate.toFixed(2)}x
                  </span>
                }
              >
                <Slider
                  aria-label={t("rateLabel")}
                  min={MIN_SPEECH_RATE}
                  max={MAX_SPEECH_RATE}
                  step={0.05}
                  value={[output.rate]}
                  onValueChange={([rate]) => updateOutput({ rate })}
                />
              </SettingRow>
              <SettingRow
                icon={Wand2}
                title={t("autoReadLabel")}
                description={t("autoReadDescription")}
                htmlFor="speech-output-auto-read"
                control={
                  <Switch
                    id="speech-output-auto-read"
                    aria-label={t("autoReadLabel")}
                    checked={output.autoRead}
                    onCheckedChange={(autoRead) => updateOutput({ autoRead })}
                  />
                }
              />
            </SettingCard>
          )}
        </SettingsSection>

        <SettingsSection
          icon={Cloud}
          title={t("cloudTitle")}
          description={t("cloudDescription")}
        >
          {loadError && (
            <SettingsError>
              {t("loadFailed", { message: loadError })}
            </SettingsError>
          )}
          {cloud && (
            <SettingCard>
              <SettingRow
                icon={Link}
                title={t("baseUrl")}
                htmlFor="speech-cloud-base-url"
              >
                <Input
                  id="speech-cloud-base-url"
                  className="h-8 text-xs"
                  value={cloud.baseUrl}
                  onChange={(e) =>
                    setCloud({ ...cloud, baseUrl: e.target.value })
                  }
                  spellCheck={false}
                />
              </SettingRow>
              <SettingRow
                icon={KeyRound}
                title={t("apiKey")}
                description={t("apiKeyDescription")}
                htmlFor="speech-cloud-api-key"
                control={
                  apiKeySet ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={saving}
                      onClick={() => void persistCloud("", t("keyRemoved"))}
                    >
                      {t("removeKey")}
                    </Button>
                  ) : undefined
                }
              >
                <Input
                  id="speech-cloud-api-key"
                  type="password"
                  className="h-8 text-xs"
                  value={apiKeyDraft}
                  onChange={(e) => setApiKeyDraft(e.target.value)}
                  placeholder={
                    apiKeySet ? t("apiKeySaved") : t("apiKeyPlaceholder")
                  }
                  autoComplete="new-password"
                />
              </SettingRow>
              <SettingRow
                icon={AudioLines}
                title={t("sttModel")}
                htmlFor="speech-cloud-stt-model"
              >
                <Input
                  id="speech-cloud-stt-model"
                  className="h-8 text-xs"
                  value={cloud.sttModel}
                  onChange={(e) =>
                    setCloud({ ...cloud, sttModel: e.target.value })
                  }
                  spellCheck={false}
                />
              </SettingRow>
              <SettingRow
                icon={Volume2}
                title={t("ttsModel")}
                htmlFor="speech-cloud-tts-model"
              >
                <Input
                  id="speech-cloud-tts-model"
                  className="h-8 text-xs"
                  value={cloud.ttsModel}
                  onChange={(e) =>
                    setCloud({ ...cloud, ttsModel: e.target.value })
                  }
                  spellCheck={false}
                />
              </SettingRow>
              <SettingRow
                icon={Speaker}
                title={t("ttsVoice")}
                htmlFor="speech-cloud-tts-voice"
              >
                <Input
                  id="speech-cloud-tts-voice"
                  className="h-8 text-xs"
                  value={cloud.ttsVoice}
                  onChange={(e) =>
                    setCloud({ ...cloud, ttsVoice: e.target.value })
                  }
                  spellCheck={false}
                />
              </SettingRow>
              <SettingsSaveBar
                className="px-3 pb-3"
                onSave={() =>
                  void persistCloud(
                    apiKeyDraft ? apiKeyDraft : null,
                    t("saved")
                  )
                }
                saving={saving}
                label={t("save")}
                savingLabel={t("saving")}
              />
            </SettingCard>
          )}
        </SettingsSection>
      </div>
    </ScrollArea>
  )
}
