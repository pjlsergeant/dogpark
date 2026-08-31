import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { Copyable, Empty, Fact, Facts, Failure, Id, Loading, Pill, Time } from './bits.js';
import { apiError } from '../stories/harness.js';
import * as fixture from '../stories/fixtures.js';

/**
 * The small shared pieces, all hand-rolled. Between them they are most of the
 * app's texture, so they are worth looking at on their own.
 */
const meta = {
  title: 'Components/Bits',
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** Relative, with the absolute time on hover; and the never case. */
export const Times: Story = {
  parameters: { expectText: ['Last activity', 'never'] },
  render: () => (
    <Facts>
      <Fact name="Last activity">
        <Time iso={fixture.wrapUp.sentAt} />
      </Fact>
      <Fact name="Created">
        <Time iso="2026-06-02T09:00:00.000Z" />
      </Fact>
      <Fact name="Last seen">
        <Time iso={null} />
      </Fact>
    </Facts>
  ),
};

export const Waiting: Story = {
  parameters: { expectText: ['Loading escalations'] },
  render: () => <Loading what="escalations" />,
};

export const Nothing: Story = {
  parameters: { expectText: ['Nothing has been escalated.'] },
  render: () => <Empty>Nothing has been escalated.</Empty>,
};

export const Failed: Story = {
  parameters: { expectText: ['No such space.'] },
  render: () => <Failure error={apiError('not_found', 'No such space.')} onRetry={fn()} />,
};

/** Rate limiting is the one failure that says when to come back. */
export const FailedWithRetry: Story = {
  parameters: { expectText: ['40 requests a minute for this session.'] },
  render: () => (
    <Failure
      error={apiError('rate_limited', '40 requests a minute for this session.')}
      onRetry={fn()}
    />
  ),
};

/** The once-only key, and the environment snippet beside it. */
export const Copying: Story = {
  parameters: { expectText: ['DOGPARK_URL=https://dogpark.example.com'] },
  render: () => (
    <>
      <Copyable value="dgp_ag_9c41f0a7be32_2f8c41a90b6e7d35c018a4be92f7c103" label="the key" />
      <Copyable
        value={
          'DOGPARK_URL=https://dogpark.example.com\n' +
          'DOGPARK_KEY=dgp_ag_9c41f0a7be32_2f8c41a90b6e7d35c018a4be92f7c103\n' +
          '# how to use them: https://dogpark.example.com/agent-guide.md'
        }
        label="the environment snippet"
        multiline
      />
    </>
  ),
};

export const Ids: Story = {
  parameters: { expectText: ['ag_9c41f0a7be32'] },
  render: () => (
    <p>
      <Id value={fixture.dp1.id} /> <Id value={fixture.rotation.id} /> <Id value="cu_8f2a" />
    </p>
  ),
};

export const Pills: Story = {
  parameters: { expectText: ['2 not delivered'] },
  render: () => (
    <p className="row">
      <Pill tone="ok">sent</Pill>
      <Pill tone="info">stream</Pill>
      <Pill tone="warn">2 not delivered</Pill>
      <Pill tone="bad">failed</Pill>
      <Pill tone="muted">archived</Pill>
    </p>
  ),
};

export const FactList: Story = {
  parameters: { expectText: ['Attempts claiming this id'] },
  render: () => (
    <Facts>
      <Fact name="Id">
        <Id value={fixture.dp4.id} />
      </Fact>
      <Fact name="Created">
        <Time iso="2026-08-28T13:05:00.000Z" />
      </Fact>
      <Fact name="Last seen">
        <span className="muted">never</span>
      </Fact>
      <Fact name="Attempts claiming this id">6</Fact>
    </Facts>
  ),
};
