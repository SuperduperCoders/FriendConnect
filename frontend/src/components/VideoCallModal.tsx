import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useSocket } from '../contexts/SocketContext';

interface Props {
  incoming: {
    callId: string; chatId: string; callerId: string;
    callerName: string; callerAvatar: string; isGroup: boolean;
  };
  onClose: () => void;
}

export default function VideoCallModal({ incoming, onClose }: Props) {
  const { socket } = useSocket();
  const [videoStream, setVideoStream] = useState<MediaStream | null>(null);
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);

  const servers = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  useEffect(() => {
    startCall();
    return () => { videoStream?.getTracks().forEach(t => t.stop()); peerRef.current?.close(); };
  }, []);

  const startCall = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setVideoStream(stream);
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      const pc = new RTCPeerConnection(servers);
      peerRef.current = pc;
      stream.getTracks().forEach(t => pc.addTrack(t, stream));

      pc.onicecandidate = (e) => {
        if (e.candidate) socket?.emit('ice_candidate', { to: incoming.callerId, candidate: e.candidate, callId: incoming.callId });
      };
      pc.ontrack = (e) => {
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = e.streams[0];
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket?.emit('call_offer', { to: incoming.callerId, offer, callId: incoming.callId });

      socket?.on('call_answer', async ({ answer }: any) => {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
        }
      });
      socket?.on('ice_candidate', async ({ candidate }: any) => {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      });
    } catch (err) {
      console.error('Failed to start call:', err);
      onClose();
    }
  };

  const toggleCam = () => {
    videoStream?.getVideoTracks().forEach(t => { t.enabled = !t.enabled; });
    setCamOn(!camOn);
    socket?.emit('call_cam_state', { chatId: incoming.chatId, camOn: !camOn, callId: incoming.callId });
  };

  const toggleMic = () => {
    videoStream?.getAudioTracks().forEach(t => { t.enabled = !t.enabled; });
    setMicOn(!micOn);
    socket?.emit('call_mic_state', { chatId: incoming.chatId, micOn: !micOn, callId: incoming.callId });
  };

  const accept = () => {
    socket?.emit('call_peer_join', { chatId: incoming.chatId, callId: incoming.callId, callerId: incoming.callerId });
  };

  const reject = () => {
    socket?.emit('call_reject', { callerId: incoming.callerId, callId: incoming.callId });
    videoStream?.getTracks().forEach(t => t.stop());
    onClose();
  };

  const endCall = () => {
    socket?.emit('call_end', { chatId: incoming.chatId, callId: incoming.callId });
    videoStream?.getTracks().forEach(t => t.stop());
    peerRef.current?.close();
    onClose();
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-2xl p-6 max-w-sm w-full text-center">
        <div className="text-5xl mb-3">{incoming.callerAvatar}</div>
        <h3 className="text-white text-xl font-bold mb-1">{incoming.callerName}</h3>
        <p className="text-gray-400 text-sm mb-4">{incoming.isGroup ? 'Group Video Call' : 'Video Call'}</p>

        <div className="relative w-full aspect-video bg-gray-800 rounded-xl overflow-hidden mb-4">
          <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover" />
          <video ref={localVideoRef} autoPlay playsInline muted
            className="absolute bottom-2 right-2 w-20 h-14 rounded-lg object-cover border border-white/20" />
        </div>

        <div className="flex gap-3 justify-center mb-4">
          <button onClick={toggleCam}
            className={`p-3 rounded-full ${camOn ? 'bg-gray-700 text-white' : 'bg-red-600 text-white'}`}>
            {camOn ? '📹' : '📷'}
          </button>
          <button onClick={toggleMic}
            className={`p-3 rounded-full ${micOn ? 'bg-gray-700 text-white' : 'bg-red-600 text-white'}`}>
            {micOn ? '🎤' : '🔇'}
          </button>
        </div>

        <div className="flex gap-2">
          <button onClick={accept} className="flex-1 py-3 bg-green-600 text-white rounded-xl font-bold">Accept</button>
          <button onClick={reject} className="flex-1 py-3 bg-red-600 text-white rounded-xl font-bold">Reject</button>
          <button onClick={endCall} className="flex-1 py-3 bg-gray-600 text-white rounded-xl font-bold">End</button>
        </div>
      </div>
    </motion.div>
  );
}
