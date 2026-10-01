# 音频业务样本

这些样本只用于本地业务回归，不包含家庭录音。

## 清晰语音

`speech-16k.pcm` 是 macOS 内置 Samantha 语音合成的句子：

> Someone is speaking in the living room. Please turn on the light. The front door is open.

生成后由 FFmpeg 转为 16 kHz、单声道、有符号 16 位小端序 PCM。句子为测试编写；样本由系统语音合成生成，不从第三方音频数据集提取。测试自行前后添加静音，检查人声概率、声音能量与连续性，不检查转写内容。

```sh
say -v Samantha -o /tmp/perception-speech.aiff \
  'Someone is speaking in the living room. Please turn on the light. The front door is open.'
ffmpeg -i /tmp/perception-speech.aiff -ar 16000 -ac 1 -f s16le speech-16k.pcm
```

## Opus 静音

`opus-silence.ogg` 由 `docker/go2rtc/overlay/internal/xiaomi/home_agent_audio_test.go` 的真实音频 consumer 生成。输入为 40 个交替 20/40 ms 的有效 Opus 静音包，源时长 1.2 秒。固定 Pion 封装器声明 80 ms pre-skip，解码后音频加上该偏移应恢复源时长。

在应用构建补丁并复制 overlay 的 go2rtc 源码中执行，可用 `P3_OPUS_FIXTURE_OUT` 指定重新生成位置：

```sh
P3_OPUS_FIXTURE_OUT=/tmp/opus-silence.ogg \
  go test ./internal/xiaomi -run '^TestAudioTimelineSurvivesOpusPackaging$' -count=1
```

该用例同时以真实 FFmpeg 解码核对时长；输出中的 Ogg stream serial 随机，重新生成不要求文件逐字节相同。不要用实际摄像头录音替换这些样本。
