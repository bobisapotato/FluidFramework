import { BoxcarType, IBoxcarMessage } from "@prague/routerlicious/dist/core";
import { IPendingBoxcar, IProducer } from "@prague/routerlicious/dist/utils";
import { Deferred } from "@prague/utils";
import * as Kafka from "node-rdkafka";

const MaxBatchSize = Number.MAX_VALUE;

export class RdkafkaProducer implements IProducer {
    private messages = new Map<string, IPendingBoxcar[]>();
    private producer: Kafka.Producer;
    private connected = false;
    private sendPending: NodeJS.Immediate;
    private pendingMessageCount = 0;

    constructor(endpoint: string, private topic: string, private maxMessageSize: number) {
        this.maxMessageSize = maxMessageSize * 0.75;

        this.producer = new Kafka.Producer(
            {
                "dr_cb": true,    // delivery report callback
                "metadata.broker.list": endpoint,
                "queue.buffering.max.ms": 1,
            },
            null);
        this.producer.setPollInterval(100);

        // logging debug messages, if debug is enabled
        this.producer.on("event.log", (log) => {
            console.log(log);
        });

        // logging all errors
        this.producer.on("event.error", (err) => {
            console.error("Error from producer");
            console.error(err);
        });

        // Wait for the ready event before producing
        this.producer.on("ready", (arg) => {
            console.log("producer ready." + JSON.stringify(arg));
        });

        this.producer.on("disconnected", (arg) => {
            console.log("producer disconnected. " + JSON.stringify(arg));
        });

        // starting the producer
        this.producer.connect(
            null,
            (error, data) => {
                console.log(`Connected`, error, data);
                this.connected = true;
                this.requestSend();
            });

        this.producer.on("delivery-report", (err, report) => {
            if (err) {
                console.error(err);
                report.opaque.reject(err);
            } else {
                report.opaque.resolve();
            }
        });
    }

    public async send(message: string, tenantId: string, documentId: string): Promise<any> {
        if (message.length >= this.maxMessageSize) {
            return Promise.reject("Message too large");
        }

        const key = `${tenantId}/${documentId}`;

        // Get the list of boxcars for the given key
        if (!this.messages.has(key)) {
            this.messages.set(key, []);
        }
        const boxcars = this.messages.get(key);

        // Create a new boxcar if necessary
        if (boxcars.length === 0 || boxcars[boxcars.length - 1].size + message.length > this.maxMessageSize) {
            boxcars.push({
                deferred: new Deferred<void>(),
                documentId,
                messages: [],
                size: 0,
                tenantId,
            });
        }

        // Add the message to the boxcar
        const boxcar = boxcars[boxcars.length - 1];
        boxcar.messages.push(message);
        boxcar.size += message.length;
        this.pendingMessageCount++;

        // Mark the need to send a message
        this.requestSend();

        return boxcar.deferred.promise;
    }

    public close(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.producer.disconnect((err, data) => err ? reject(err) : resolve());
        });
    }

    /**
     * Notifies of the need to send pending messages. We defer sending messages to batch together messages
     * to the same partition.
     */
    private requestSend() {
        // If we aren't connected yet defer sending until connected
        if (!this.connected) {
            return;
        }

        // Limit max queued up batch size
        if (this.pendingMessageCount >= MaxBatchSize) {
            clearImmediate(this.sendPending);
            this.sendPending = undefined;
            this.sendPendingMessages();
            return;
        }

        // Exit early if there is a pending send
        if (this.sendPending) {
            return;
        }

        // use setImmediate to play well with the node event loop
        this.sendPending = setImmediate(() => {
            this.sendPendingMessages();
            this.sendPending = undefined;
        });
    }

    /**
     * Sends all pending messages
     */
    private sendPendingMessages() {
        for (const [, value] of this.messages) {
            for (const boxcar of value) {
                const boxcarMessage: IBoxcarMessage = {
                    contents: boxcar.messages,
                    documentId: boxcar.documentId,
                    tenantId: boxcar.tenantId,
                    type: BoxcarType,
                };

                this.producer.produce(
                    this.topic,
                    null,
                    Buffer.from(JSON.stringify(boxcarMessage)),
                    boxcar.documentId,
                    Date.now(),
                    boxcar.deferred);
            }
        }

        this.pendingMessageCount = 0;
        this.messages.clear();
    }
}
