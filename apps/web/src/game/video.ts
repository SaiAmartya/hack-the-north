/** Video only. Laptop microphone capture belongs exclusively to local speech. */
export class VideoLink {
  private pc?: RTCPeerConnection;
  private video?: RTCRtpTransceiver;
  private epoch = 0;
  private localVideoGeneration = 0;
  private tail: Promise<void> = Promise.resolve();
  private receiveSignal: (
    payload: Record<string, unknown>,
    generation: number,
  ) => Promise<void> = async () => {};

  constructor(
    private readonly send: (message: Record<string, unknown>) => void,
    private readonly onStream: (stream: MediaStream) => void,
    private readonly onIssue: (issue: string) => void,
  ) {}

  start(local: MediaStream, polite: boolean, iceServers: RTCIceServer[] = []) {
    this.stop();
    const epoch = this.epoch;
    const videoGeneration = (this.localVideoGeneration += 1);
    const pc = (this.pc = new RTCPeerConnection({ iceServers }));
    const track = local.getVideoTracks()[0];
    this.video = track
      ? pc.addTransceiver(track, {
          direction: "sendrecv",
          streams: [local],
        })
      : pc.addTransceiver("video", { direction: "recvonly" });

    let makingOffer = false;
    let ignoreOffer = false;
    let settingAnswer = false;
    let candidates: RTCIceCandidateInit[] = [];
    let remoteConnectionGeneration = -1;
    let remoteVideoGeneration = -1;
    const active = () => this.pc === pc && this.epoch === epoch;
    const signal = (message: Record<string, unknown>) => {
      if (active()) this.send({ ...message, videoGeneration });
    };

    pc.ontrack = (event) => {
      if (event.track.kind === "video" && active())
        this.onStream(event.streams[0] ?? new MediaStream([event.track]));
    };
    pc.onicecandidate = (event) => {
      if (event.candidate) signal({ candidate: event.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (
        active() &&
        ["failed", "disconnected"].includes(pc.connectionState)
      )
        this.onIssue("Camera connection interrupted");
    };
    pc.onnegotiationneeded = async () => {
      if (!active()) return;
      try {
        makingOffer = true;
        await pc.setLocalDescription();
        if (active()) signal({ description: pc.localDescription?.toJSON() });
      } catch {
        if (active()) this.onIssue("Camera connection unavailable");
      } finally {
        if (active()) makingOffer = false;
      }
    };

    this.receiveSignal = async (payload, generation) => {
      if (!active()) return;
      const incomingVideoGeneration = payload.videoGeneration;
      if (
        !Number.isSafeInteger(incomingVideoGeneration) ||
        (incomingVideoGeneration as number) < 1
      )
        throw new Error("Invalid video generation");
      const videoGenerationNumber = incomingVideoGeneration as number;
      if (generation < remoteConnectionGeneration) return;
      if (
        generation === remoteConnectionGeneration &&
        videoGenerationNumber < remoteVideoGeneration
      )
        return;

      const rawDescription = payload.description;
      const rawCandidate = payload.candidate;
      const hasDescription = rawDescription !== undefined;
      const hasCandidate = rawCandidate !== undefined;
      if (hasDescription === hasCandidate)
        throw new Error("Invalid video signal envelope");
      let description: RTCSessionDescriptionInit | undefined;
      let candidate: RTCIceCandidateInit | undefined;
      if (hasDescription) {
        if (typeof rawDescription !== "object" || rawDescription === null)
          throw new Error("Invalid video description");
        description = rawDescription as RTCSessionDescriptionInit;
        if (
          !["offer", "answer"].includes(description.type) ||
          typeof description.sdp !== "string" ||
          description.sdp.length > 32_768 ||
          /^m=audio /m.test(description.sdp)
        )
          throw new Error("Invalid video description");
      } else {
        if (typeof rawCandidate !== "object" || rawCandidate === null)
          throw new Error("Invalid ICE candidate");
        candidate = rawCandidate as RTCIceCandidateInit;
        if (
          typeof candidate.candidate !== "string" ||
          candidate.candidate.length > 2048
        )
          throw new Error("Invalid ICE candidate");
      }

      if (generation > remoteConnectionGeneration) {
        remoteConnectionGeneration = generation;
        remoteVideoGeneration = -1;
        candidates = [];
        ignoreOffer = false;
      }
      if (videoGenerationNumber < remoteVideoGeneration) return;
      if (videoGenerationNumber > remoteVideoGeneration) {
        remoteVideoGeneration = videoGenerationNumber;
        candidates = [];
        ignoreOffer = false;
      }

      try {
        if (description) {
          const collision =
            description.type === "offer" &&
            (makingOffer ||
              (pc.signalingState !== "stable" && !settingAnswer));
          ignoreOffer = !polite && collision;
          if (ignoreOffer) return;
          settingAnswer = description.type === "answer";
          try {
            await pc.setRemoteDescription(description);
          } finally {
            settingAnswer = false;
          }
          if (!active()) return;
          for (const entry of candidates) await pc.addIceCandidate(entry);
          candidates = [];
          if (description.type === "offer") {
            await pc.setLocalDescription();
            if (active()) signal({ description: pc.localDescription?.toJSON() });
          }
        } else if (candidate && !ignoreOffer) {
          if (pc.remoteDescription) await pc.addIceCandidate(candidate);
          else {
            if (candidates.length >= 64)
              throw new Error("Too many ICE candidates");
            candidates.push(candidate);
          }
        }
      } catch {
        if (!ignoreOffer && active())
          this.onIssue("Camera connection unavailable");
      }
    };
  }

  async setLocalStream(local: MediaStream): Promise<void> {
    const pc = this.pc;
    const video = this.video;
    const epoch = this.epoch;
    if (!pc || !video) return;
    const track = local.getVideoTracks()[0] ?? null;
    try {
      await video.sender.replaceTrack(track);
      if (this.pc !== pc || this.epoch !== epoch) return;
      if (track) video.sender.setStreams(local);
      else video.sender.setStreams();
      video.direction = track ? "sendrecv" : "recvonly";
    } catch (error) {
      if (this.pc === pc && this.epoch === epoch)
        this.onIssue("Camera connection unavailable");
      throw error;
    }
  }

  receive(payload: Record<string, unknown>, generation: number) {
    const epoch = this.epoch;
    const receiver = this.receiveSignal;
    const task = this.tail.then(() => {
      if (epoch !== this.epoch) return;
      return receiver(payload, generation);
    });
    this.tail = task.catch(() => {
      if (epoch === this.epoch)
        this.onIssue("Camera connection unavailable");
    });
  }

  stop() {
    this.epoch++;
    this.pc?.close();
    this.pc = undefined;
    this.video = undefined;
    this.receiveSignal = async () => {};
    this.tail = Promise.resolve();
  }
}
