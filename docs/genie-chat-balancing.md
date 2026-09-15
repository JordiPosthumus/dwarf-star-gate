# Queue balancing in Genie chat

With local worker management and the queue-balancing capability enabled, Genie
can inspect current worker load and move eligible waiting work directly from chat.
Try: “Check the queues and move a waiting job if an idle server can help.”

`queue_balance_status` reads fresh core state and its exact move offers.
`move_waiting_job` uses the same core executor as routine fleet reviews. The
existing queue-pressure trigger (two or more waiting jobs with an eligible idle
machine) and single-job wait threshold are unchanged. The executor checks the
current switch, request, source, destination, session conflicts and evidence again.
It preserves active jobs, original client sockets and deadlines. Cache locality
on the destination remains unknown. No model-server settings change.

Each call and returned receipt is saved with the chat and shown under **Queue
balancing activity**. A failed or uncertain call is not success and must not be
replayed. Fresh status includes the latest move receipt; normal gateway activity
keeps its existing relocation history. Chat works independently of routine reviews.
Turning off queue balancing blocks subsequent moves, including calls from an
already-running reply; completed moves are not undone.

This adds no new configuration file, scheduler, background process or approval
queue. No separate approval is required for an eligible move while the capability
is enabled. Server changes and benchmark starts retain their own approval controls.
