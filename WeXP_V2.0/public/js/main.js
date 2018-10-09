(function(win) {
    win.rtc = {
        register: register,
        call: call,
        stop: stopCommunication,
        list: list,
        videoswitch: videoswitch,
    };

    var ua = navigator ? navigator.userAgent : 'Version/1';
    var isFirefox = ua.match(/firefox/i);
    var browserVersion = ua.match(/(Chrome|Firefox|Version)\/(\d+)\b/).pop();
    navigator.getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia;

    var createOfferConstraints = isFirefox && browserVersion > 34 ? {
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
    } : {
        mandatory: {
            OfferToReceiveAudio: true,
            OfferToReceiveVideo: true
        },
        optional: [{
            DtlsSrtpKeyAgreement: true
        }]
    };

    var userMediaOptions = {
        audio: true,
        video: {
            width: 1280,
            height: 720,
            framerate: 60,
        }
    };


    var canvas_flag = 0;
    var videoInput, videoOutput, videocanv;
    win.onload = function() {
        videoInput = document.getElementById('videoInput');
        videoOutput = document.getElementById('videoOutput');
        videocanv = document.getElementById('videocanv');
    };

    const STATE = {
        INITIAL: 0,
        WAITING: 1,
        PROCESSING: 2,
        IN_CALL: 3
    };
    var callState;
    setState(STATE.INITIAL, 'initial');

    var host = win.location.hostname;
    var port = win.location.port;
    var canvas;
    canvas = document.querySelector('canvas');
    const WS_URL = 'wss://' + host + (port !== 80 ? (':' + port) : '') + '/call';
    var ws = new WebSocket(WS_URL);
    ws.onmessage = handleMessage;
    ws.onopen = function() {
        setTimeout(idle, 30000);
    };

    var configuration = {
        iceServers: [{
            'urls': "stun:stun.l.google.com:19302" //stun server.
        }, {
            'urls': "stun:stun1.l.google.com:19302"
        }, {
            'urls': "stun:stun.services.mozilla.com"
        }]
    };

    var pc, pc1, pc2;
    var addIceBuffered;
    var canvas_flag = 0;
    /** signaling communication */
    function handleMessage(msg) {
        msg = JSON.parse(msg.data);
        console.debug('ws:in: ', msg);

        switch (msg.id) {
            case 'registerResponse':
                if (msg.response === 'accepted') {
                    setState(STATE.WAITING, 'registered');
                }
                break;
            case 'incomingCall':
                incomingCall(msg);
                break;
            case 'incomingMsg':
                break;
            case 'startCommunication':
                setState(STATE.IN_CALL, 'in call');
                startCommunication(msg, 'callee');
                break;
            case 'stopCommunication':
                setState(STATE.WAITING, 'stopped');
                stopCommunication();
            case 'callResponse':
                if (msg.response === 'rejected') {
                    setState(STATE.WAITING, msg.message);
                } else {
                    setState(STATE.IN_CALL, 'call response');
                    startCommunication(msg, 'caller');
                }
                break;
            case 'iceCandidate':
                remoteIceCandidate(msg.candidate);
                break;
        }
    }

    function sendMessage(msg) {
        console.debug('ws:out:', msg);
        ws.send(JSON.stringify(msg));
    }

    function register(name) {
        sendMessage({
            id: 'register',
            name: name
        });
    }

    function list() {
        sendMessage({
            id: 'list'
        });
    }

    function remoteIceCandidate(candidate) {
        console.debug('pc:addIceCandidate:', candidate);
        if (candidate) {
            addIceBuffered(new RTCIceCandidate(candidate), onError('addIce'));
        }
    }

    function localIceCandidate(e) {
        // no more candidates
        if (!e.candidate) return false;

        console.debug('pc:onicecandidate', e.candidate);
        sendMessage({
            id: 'onIceCandidate',
            candidate: e.candidate
        });
    }

    function incomingCall(msg) {
        if (callState !== STATE.WAITING) {
            return sendMessage({
                id: 'incomingCallResponse',
                from: msg.from,
                callResponse: 'reject',
                message
            });
        }

        setState(STATE.PROCESSING, 'incoming call');

        pc = new RTCPeerConnection(configuration);

        addIceBuffered = bufferizeCandidates(pc);
        // send ice candidates to the other peer
        pc.onicecandidate = localIceCandidate;
        var sendDataCh = pc.createDataChannel("chat");
        //MediaOption, Success callback, Error callback.
        navigator.getUserMedia(userMediaOptions, function(stream) {
            showLocalVideo(stream);
            pc.addStream(stream);

            console.debug('pc.setRemoteDescription', msg.offer);
            pc.setRemoteDescription(new RTCSessionDescription(msg.offer))
                .then(function() {
                    return pc.createAnswer(createOfferConstraints);
                })
                .then(function(answer) {
                    console.debug('pc:createAnswer:', answer);
                    return pc.setLocalDescription(answer);
                })
                .then(function() {
                    sendMessage({
                        id: 'incomingCallResponse',
                        from: msg.from,
                        callResponse: 'accept',
                        sdpOffer: pc.localDescription
                    })
                })
                .catch(onError('pc:createAnswer'));
        }, onError('nav:getUserMedia')); //error callback.

        // when the remote track arrives
        pc.ontrack = function(evt) {
            console.debug('pc:ontrack', evt);
            if (evt.track && evt.track.kind === 'video') {
                if (canvas_flag === 0) {
                    showRemoteVideo(evt.streams[0]);
                } else {
                    canvas_flag = 0;
                }
            }
        }

        pc.on = function(evt) {
            console.debug('pc:onstream', evt);
            if (evt.stream) {
                if (canvas_flag === 0) {
                    showRemoteVideo(evt.stream);
                } else {
                    canvas_flag = 0;
                }
            }
        }

        pc.ondatachannel = function(event) {
            var receiveCh = event.channel;
            receiveCh.onmessage = function(event) {
                console.log("Receive meesage :" + event.data);
                var msg_recv = document.querySelector('#dataChannelReceive');
                msg_recv.value += "Admin :" + event.data + "\n";
                msg_recv.scrollTop = msg_recv.scrollHeight;
            };
        };

        var sendDataCh = pc.createDataChannel("chat", {
            reliable: true,
            ordered: true
        });
    }

    function stopCommunication() {
        videoInput.pause();
        videoOutput.pause();

        if (pc && pc.signalingState !== 'closed') {
            pc.getLocalStreams().forEach(function(stream) {
                stream.getTracks().forEach(function(track) {
                    track.stop && track.stop();
                });
            });
        }
        sendMessage({
            id: 'stop'
        });
        videoInput.src = '';
        videoOutput.src = '';
    }

    /**
     * Start communcation
     * @param  {Object} msg  incoming message with sdpAnswer
     * @param  {String} type 'callee|caller'
     */
    function startCommunication(msg, type) {
        console.log('start communication', msg);
        pc.setRemoteDescription(new RTCSessionDescription(msg.sdpAnswer))
            .then(function() {
                console.debug('pc:setRemoteDescription:success');
            }).catch(onError('pc.setRemoteDescription'));
    }

    function call(callee, caller) {
        setState(STATE.PROCESSING, 'calling');
        pc = new RTCPeerConnection(configuration); //local
        addIceBuffered = bufferizeCandidates(pc);
        pc.onicecandidate = localIceCandidate;

        var stream2;
        stream2 = canvas.captureStream();
        navigator.getUserMedia(userMediaOptions, function(stream) {
            showLocalVideo(stream);
            console.log('addstream(call)');

            pc.addStream(stream2);
            pc.createOffer(createOfferConstraints)
                .then(function(offer) {
                    console.debug('pc:createOffer:', offer);
                    return pc.setLocalDescription(offer);
                })
                .then(function() {
                    sendMessage({
                        id: 'call',
                        from: caller,
                        to: callee,
                        sdpOffer: pc.localDescription
                    })
                })
                .catch(onError('pc:createOffer'));
        }, onError('nav:getUserMedia'));


        // when the remote track arrives(this pc)
        pc.ontrack = function(evt) {
            console.debug('pc:ontrack', evt);
            if (evt.track.kind === 'video') {
                showRemoteVideo(evt.streams[0]);
            }
        }

        pc.onaddstream = function(evt) {
            console.debug('pc:onstream', evt);
            if (evt.stream) {
                if (canvas_flag === 0) {
                    showRemoteVideo(evt.stream);
                } else {
                    canvas_flag = 0;
                }
            }
        }

        pc.ondatachannel = function(event) {
            var receiveCh = event.channel;
            receiveCh.onmessage = function(event) {
                console.log("Receive meesage :" + event.data);
                var msg_recv = document.querySelector('#dataChannelReceive');
                msg_recv.value += event.data + "\n";
                msg_recv.scrollTop = msg_recv.scrollHeight;
            };
        };
        var sendDataCh = pc.createDataChannel("chat", {
            reliable: true,
            ordered: true
        });
        document.querySelector('#btn_send').onclick = function() { //local peer
            sendmsg();
        };
        document.querySelector('#dataChannelSend').addEventListener('keypress', function(e) {
            var key = e.which || e.keyCode;
            if (key === 13)
                sendmsg();
        });

        function sendmsg() {
            var data = document.querySelector('#dataChannelSend').value;
            document.querySelector('#dataChannelReceive').value += "Sending messages >> " + data + "\n";
            document.querySelector('#dataChannelReceive').scrollTop = document.querySelector('#dataChannelReceive').scrollHeight;
            sendDataCh.send(data);
            document.querySelector('#dataChannelSend').value = '';
            document.querySelector('#dataChannelSend').focus();
        }
    }

    function bufferizeCandidates(pc, onerror) {
        var candidatesQueue = [];
        pc.addEventListener('signalingstatechange', function() {
            if (this.signalingState === 'stable') {
                while (candidatesQueue.length) {
                    var entry = candidatesQueue.shift();
                    this.addIceCandidate(entry);
                }
            }
        });
        return function(candidate, callback) {
            callback = callback || onerror;
            switch (pc.signalingState) {
                case 'closed':
                    callback(new Error('PeerConnection object is closed'));
                    break;
                case 'stable':
                    if (pc.remoteDescription) {
                        pc.addIceCandidate(candidate, callback, callback);
                        break;
                    }
                default:
                    candidatesQueue.push(candidate);
            }
        };
    }

    function onError(what) {
        return function(err) {
            console.warn('err:' + what, err);
        };
    }

    function showLocalVideo(stream) {
        videoInput.srcObject = stream;
        videoInput.muted = false;
    }

    function showRemoteVideo(stream) {
        var url = stream ? stream : '';
        if (videoOutput.srcObject !== stream.srcObject) {
            videoOutput.pause();
            videoOutput.srcObject = url;
            videoOutput.muted = false;
            videoOutput.load();
            console.debug('Remote URL: ', url);
        } else {
            alert('success');
            videocanv.srcObject = url;
        }
    }

    function setState(state, msg) {
        console.debug('call:state: ', state);
        callState = state;

        var elm = document.getElementById('call-state');
        if (elm) {
            elm.innerHTML = msg;
        }
    }

    function idle() {
        ws.send(JSON.stringify({
            id: 'ping'
        }));
        setTimeout(idle, 30000);
    }

    function videoswitch() {
        var one = videoOutput.srcObject;
        var two = videoInput.srcObject;
        showLocalVideo(one);
        showRemoteVideo(two);
    }

})(window);
