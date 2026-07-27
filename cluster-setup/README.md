# Cluster Setup

Infrastructure as code for standing up a Rulebricks-ready Kubernetes cluster,
with one template per cloud. Managed Kafka, Redis, and Postgres are independent
true/false toggles on each template, and any combination is valid, when disabled,
they are deployed in-cluster by the Rulebricks chart.

> These templates are reference implementations. Treat them as a starting
> point and customize them to accommodate pre-existing services or unique
> performance requirements. Each cloud README documents the design and the
> operational requirements used for infrastructure and security review.

