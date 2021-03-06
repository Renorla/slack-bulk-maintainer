import test from 'ava'
import fs from 'fs'
import SlackBulkMaintainer from '../slack-bulk-maintainer.js'

global.td = require('testdouble')

test.beforeEach(t => {
  const logger = provideLoggerStub();
  const slackClient = provideSlackWebClientStub();
  const maintainer = new SlackBulkMaintainer(slackClient, logger);
  t.context.maintainer = maintainer;
  t.context.slackClient = slackClient;
  t.context.logger = logger;
})

test.afterEach(t => {
  // Don't call td.reset() to avoid global pollution
})

test('Maintainer hold slack token', async t => {
  t.plan(4);
  const maintainer = t.context.maintainer;
  t.is(maintainer.webApi, t.context.slackClient);
  t.is(maintainer.logger, t.context.logger);
  t.is(maintainer.authUser, null);
  const summaryTemplate = {
    try: 0,
    skip: 0,
    success: 0,
    error: 0
  };
  t.deepEqual(maintainer.summary, {
      profileSet: summaryTemplate,
      postMessage: summaryTemplate
  });
});

test('Update slack users profiles', async t => {
  t.plan(5);

  const maintainer = t.context.maintainer;

  const userList = dummyUserList();

  const profileSet = maintainer.webApi.users.profile.set;
  td.when(profileSet(td.matchers.anything()))
    .thenResolve({
      ok: true
    });
  const profileSetExplain = td.explain(profileSet);

  const notifyUpdatedUser = td.replace(maintainer, 'notifyUpdatedUser');
  td.when(notifyUpdatedUser(td.matchers.anything())).thenDo(arg1 => {
    return Promise.resolve(arg1);
  });
  const notifyUpdatedUserExplain = td.explain(notifyUpdatedUser);


  const filePath = 'test/resoures/update-profiles.csv';
  const responses = await maintainer.updateProfilesFromCsv(filePath, userList.members)
    .catch(e => e);

  t.is(responses.length, 2);
  t.is(responses[0].updateQuery.skipCallApi, true);

  t.is(profileSetExplain.calls.length, 1);
  t.deepEqual(profileSetExplain.calls[0].args, [{
    'user': 'USERID2',
    'profile': {
      'status_emoji': ':sleepy:'
    }
  }]);
  t.is(notifyUpdatedUserExplain.calls.length, 2);
});

test('Fetch user list', async t => {
  t.plan(2); // FIXME include td assertions

  const maintainer = t.context.maintainer;
  const list = maintainer.webApi.users.list;
  td.when(list()).thenResolve(dummyUserList());

  const response = await maintainer.fetchUserList();

  t.is(response.ok, true);
  t.is(response.members.length, 4);
  // FIXME td.verify(list());
});

test('Find user info by email', t => {
  const maintainer = t.context.maintainer;
  const user = maintainer.findUserByMail('jiro@example.com', dummyUserList().members);
  t.is(user.id, 'USERID2');
});

test('Build update query', t => {
  t.plan(7);

  const maintainer = t.context.maintainer;
  const csvParam = {
    profile: {
      email: 'jiro@example.com',
      real_name: '田中 二郎',
      display_name: 'JIRO-T'
    }
  }
  const query = maintainer.buildUpdateQuery(csvParam, dummyUserList().members);
  t.is(query.skipCallApi, false);
  t.deepEqual(query.csvParam, csvParam);
  t.is(query.apiParam.user, 'USERID2');
  t.is(query.apiParam.profile.display_name, 'JIRO-T');
  t.is(query.apiParam.profile.real_name, undefined); // skiped
  t.deepEqual(query.skippedColumns, [{
    field: 'real_name',
    reason: 'same_with_exsiting'
  }]);
  t.not(query.currentUserInfo, null);
});

test('Build update query for admin user, it will be skipped', t => {
  t.plan(6);

  const maintainer = t.context.maintainer;
  const csvParam = {
    profile: {
      email: 'suzuki-ichiro1@example.com',
      display_name: 'ICHIRO'
    }
  }
  const query = maintainer.buildUpdateQuery(csvParam, dummyUserList().members);
  t.is(query.skipCallApi, true);
  t.deepEqual(query.skipReasons, [{
    reason: 'admin_user_cannot_be_updated',
    message: '管理者ユーザーのプロフィールを更新することはできません'
  }]);
  t.is(query.apiParam.user, null);
  t.is(query.apiParam.profile, null);
  t.deepEqual(query.skippedColumns, []);
  t.not(query.currentUserInfo, null);
});

test('Build update query for admin user, skipped due to all columns are updated', t => {
  t.plan(6);

  const maintainer = t.context.maintainer;
  const csvParam = {
    profile: {
      email: 'jiro@example.com',
      real_name: '田中 二郎',
      display_name: 'JIRO'
    }
  }
  const query = maintainer.buildUpdateQuery(csvParam, dummyUserList().members);
  t.is(query.skipCallApi, true);
  t.deepEqual(query.skipReasons, [{
    reason: 'all_fields_are_updated',
    message: '全ての項目が更新済みだったので、更新APIの呼び出しをスキップしました'
  }]);
  t.is(query.apiParam.user, null);
  t.is(query.apiParam.profile, null);
  t.deepEqual(query.skippedColumns, [{
    field: 'real_name',
    reason: 'same_with_exsiting'
  }, {
    field: 'display_name',
    reason: 'same_with_exsiting'
  }]);
  t.not(query.currentUserInfo, null);
});

test('Build update query for admin user, skipped due to no user found for email', t => {
  t.plan(6);

  const maintainer = t.context.maintainer;
  const csvParam = {
    profile: {
      email: 'noone@example.com',
      display_name: '名無し'
    }
  }
  const query = maintainer.buildUpdateQuery(csvParam, dummyUserList().members);
  t.is(query.skipCallApi, true);
  t.deepEqual(query.skipReasons, [{
    reason: 'no_user_found_for_email',
    message: '指定されたメールアドレスを持つSlackユーザーが見つかりませんでした'
  }]);
  t.is(query.apiParam.user, null);
  t.is(query.apiParam.profile, null);
  t.deepEqual(query.skippedColumns, []);
  t.is(query.currentUserInfo, null);
});

test('Parse update param from CSV', t => {
  t.plan(3);
  const maintainer = t.context.maintainer;
  const filePath = 'test/resoures/update-profiles.csv';
  const csvParams = maintainer.parseParamFromCsv(filePath);

  t.is(csvParams.length, 2);
  let i = 0;
  t.deepEqual(csvParams[i++].profile, {
    status_emoji: ':sunglasses:',
    email: 'suzuki-ichiro1@example.com'
  });
  t.deepEqual(csvParams[i++].profile, {
    status_emoji: ':sleepy:',
    email: 'jiro@example.com'
  })
});

test('Notify updated user', async t => {
  t.plan(8);

  const maintainer = t.context.maintainer;
  const postMessage = maintainer.webApi.chat.postMessage;
  td.when(postMessage(td.matchers.anything()))
    .thenResolve({ ok: true });
  const postMessageExplain = td.explain(postMessage);

  const updateQuery = {
    "skipCallApi": false,
    "skipReasons": [],
    "skippedColumns": [],
    "currentUserInfo": {
      "id": "USERID2",
      "name": "jiro",
      "real_name": "田中 二郎",
      "profile": {
        "real_name": "田中 二郎",
        "display_name": "JIRO",
        "status_text": "",
        "status_emoji": "",
      },
      "is_admin": false,
      "is_owner": false,
      "is_primary_owner": false,
      "is_restricted": false,
      "is_ultra_restricted": false,
      "is_bot": false,
      "updated": 1527585010,
      "is_app_user": false,
      "has_2fa": false
    },
    "csvParam": {
      "profile": {
        "email": "jiro@example.com",
        "status_emoji": ":sleepy:"
      }
    },
    "apiParam": {
      "user": "USERID2",
      "profile": {
        "status_emoji": ":sleepy:"
      }
    }
  };

  const updateResult = {
    apiCallResponse: { ok: true },
    updateQuery: updateQuery
  }

  const response = await maintainer.notifyUpdatedUser(updateResult);

  t.is(response.notification.response.ok, true);
  t.is(postMessageExplain.calls.length, 1, 'postMessageExplain must be called once');
  const messageArg = postMessageExplain.calls[0].args[0];
  // TODO t.is(messageArg.text, '');
  t.is(messageArg.channel, 'USERID2');
  t.is(messageArg.as_user, false);
  t.is(messageArg.icon_url, 'https://slack-files2.s3-us-west-2.amazonaws.com/avatars/2016-04-18/35486615538_c9bc6670992704e477bd_88.png');
  t.deepEqual(messageArg.attachments[0], {
    color: '#81C784',
    fields: [
      {
        short: false,
        title: 'status_emoji',
        value: `変更前: \n変更後: :sleepy:`,
      },
    ],
  });
  t.deepEqual(messageArg.attachments[1], {
    title: 'Slackの運用改善に関する周知',
    title_link: 'https://mediado.slack.com/archives/C03TWFV95/p1527578576000324',
  });
  t.deepEqual(messageArg.attachments[2], {
    title: 'Slack運用に関する問い合わせ（TODO)'
  });
});

test('Fetch token user', async t => {
  t.plan(2);
  const maintainer = t.context.maintainer;
  const authTest = maintainer.webApi.auth.test;
  const user = {
    "ok": true,
    "url": "https:\/\/xxxx.slack.com\/",
    "team": "XXXX Team",
    "user": "shohei_otani",
    "team_id": "TEAMID1",
    "user_id": "USERID1"
  };
  td.when(authTest()).thenResolve(user);
  const authTestExplanation = td.explain(authTest);

  const response = await maintainer.fetchAuthUser();
  t.deepEqual(response, user);
  t.deepEqual(maintainer.authUser, user);
});

test('Is Auth User', t => {
  t.plan(3);

  const maintainer = t.context.maintainer;

  t.is(maintainer.isAuthUser('foo'), false, 'When no auth user info');

  maintainer.authUser = { user: 'foo' };
  t.is(maintainer.isAuthUser('foo'), true, 'Same user name provided');
  t.is(maintainer.isAuthUser('bar'), false, 'Different user name provided');
});

test('Convert CSV row to profile object', t => {
  t.plan(2);

  const maintainer = t.context.maintainer;

  const csvRow = {
    user: 'userCode1',
    real_name: 'Ichiro SUZUKI',
    display_name: 'ICHIRO',
    status_emoji: 'zany_face',
    email: 'xxx@example.com',
    skip_me: 'skip_me'
  }

  const profileObject = maintainer.csvRowToProfileUpdateBody(csvRow);
  t.is(profileObject.profile.skip_me, undefined,
    'Non-slack profile column must be skipped.');
  t.deepEqual(profileObject, {
    user: 'userCode1',
    profile: {
      real_name: 'Ichiro SUZUKI',
      display_name: 'ICHIRO',
      status_emoji: 'zany_face',
      email: 'xxx@example.com'
    }
  });

});

function dummyUserList() {
  const fileContent = fs.readFileSync('test/resoures/user-list.json', 'utf8');
  return JSON.parse(fileContent);
}

function provideLoggerStub() {
  return {
    log: td.func(),
    error: td.func()
  }
}

function provideSlackWebClientStub() {
  return {
    auth: {
      test: td.func()
    },
    users: {
      profile: {
        set: td.func(),
      },
      list: td.func()
    },
    chat: {
      postMessage: td.func()
    }
  }
}
